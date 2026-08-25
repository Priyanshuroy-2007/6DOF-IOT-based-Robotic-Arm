/**
 * ============================================================================
 *  ROBOTIC ARM CONTROL — Admin Dashboard (admin.js)
 * ============================================================================
 *
 *  This script implements the admin-side monitoring, serial bridge management,
 *  E-STOP control, calibration, and telemetry visualization.
 *
 *  In embedded terms, this is the "debugger / JTAG probe" interface:
 *  - Full visibility into all packet traffic (like a logic analyzer)
 *  - Override capability (like JTAG halt / register write)
 *  - Calibration (like trimming DAC offsets or PWM compare values)
 *
 *  Functional Blocks:
 *  ┌────────────────────────────────────────────────┐
 *  │  WebSocket Client ─── Admin-privileged comms   │
 *  │  E-STOP Manager ─── Latching safety control    │
 *  │  Serial Bridge UI ─── Port config & status     │
 *  │  Console Logger ─── Raw TX/RX packet display   │
 *  │  Telemetry Display ─── Live stats & counters   │
 *  │  Calibration Panel ─── Per-servo angle limits  │
 *  └────────────────────────────────────────────────┘
 */

'use strict';

/* ===========================================================================
 *  CONFIGURATION
 * ========================================================================= */

/**
 * Admin token — must match server's CONFIG.ADMIN_TOKEN.
 * In a production system, this would be a proper JWT or session token.
 *
 * We extract it from the URL query params (?token=xxx) or use the default.
 */
const ADMIN_TOKEN = new URLSearchParams(window.location.search).get('token') || 'roboarm2026';

/**
 * Joint configuration table — same as user.js for consistency.
 * Like a shared header file (#include "joints.h") in C.
 */
const JOINT_CONFIG = [
  { key: 'J1', label: 'Base',        icon: '🔄' },
  { key: 'J2', label: 'Shoulder',    icon: '💪' },
  { key: 'J3', label: 'Elbow',       icon: '🦾' },
  { key: 'J4', label: 'W.Pitch',     icon: '↕️' },
  { key: 'J5', label: 'W.Roll',      icon: '↩️' },
  { key: 'J6', label: 'Gripper',     icon: '✊' },
];

/** Maximum lines in console output (circular buffer). */
const MAX_CONSOLE_LINES = 500;

/** Maximum lines in event log. */
const MAX_EVENT_LINES = 200;

/* ===========================================================================
 *  STATE VARIABLES (volatile globals in C terms)
 * ========================================================================= */
let eStopEngaged = false;         // E-STOP latch state
let userInputLocked = false;      // User lock state
let serialConnected = false;      // Serial port open flag
let consoleFilter = 'all';        // Console filter: 'all', 'tx', 'rx'
let consoleLinesCount = 0;        // Current console line count
let activeDriverId = null;        // Track the single driver
let lastKnownClients = null;

/* ===========================================================================
 *  DOM REFERENCES (register pointers)
 * ========================================================================= */
const DOM = {
  // Header
  statusPill:          document.getElementById('statusPill'),
  statusText:          document.getElementById('statusText'),
  latencyBadge:        document.getElementById('latencyBadge'),
  latencyValue:        document.getElementById('latencyValue'),
  uptimeBadge:         document.getElementById('uptimeBadge'),
  uptimeValue:         document.getElementById('uptimeValue'),

  // E-STOP
  btnEstop:            document.getElementById('btnEstop'),
  estopHint:           document.getElementById('estopHint'),

  // User lock
  toggleLockUsers:     document.getElementById('toggleLockUsers'),

  // Client list
  authRequestsList:    document.getElementById('authRequestsList'),
  clientList:          document.getElementById('clientList'),

  // Serial
  serialPort:          document.getElementById('serialPort'),
  serialBaud:          document.getElementById('serialBaud'),
  btnSerialConnect:    document.getElementById('btnSerialConnect'),
  btnSerialDisconnect: document.getElementById('btnSerialDisconnect'),
  btnRefreshPorts:     document.getElementById('btnRefreshPorts'),
  serialHeartbeat:     document.getElementById('serialHeartbeat'),
  serialStatusBadge:   document.getElementById('serialStatusBadge'),

  // Stats
  statTxRate:          document.getElementById('statTxRate'),
  statRxRate:          document.getElementById('statRxRate'),
  statTxTotal:         document.getElementById('statTxTotal'),
  statRxTotal:         document.getElementById('statRxTotal'),
  statUsers:           document.getElementById('statUsers'),
  statAdmins:          document.getElementById('statAdmins'),

  // Joint readout
  jointReadout:        document.getElementById('jointReadout'),

  // User Input Preview (read‑only joysticks)
  previewLeft:         document.getElementById('previewLeft'),
  previewRight:        document.getElementById('previewRight'),

  // Console
  consoleOutput:       document.getElementById('consoleOutput'),
  btnClearConsole:      document.getElementById('btnClearConsole'),

  // Calibration
  calibrationPanel:    document.getElementById('calibrationPanel'),
  btnApplyCalibration: document.getElementById('btnApplyCalibration'),
  btnResetCalibration: document.getElementById('btnResetCalibration'),

  // Event log
  eventLog:            document.getElementById('eventLog'),
};

/* ===========================================================================
 *  WEBSOCKET CLIENT — Admin-privileged connection
 * ===========================================================================
 *
 *  Same pattern as user.js but connects with admin role + token.
 *  Like a JTAG debugger connecting with elevated privileges — full read/write
 *  access to all registers and memory.
 */

let ws = null;
let wsConnected = false;
let reconnectAttempts = 0;
let heartbeatInterval = null;
let lastHeartbeatSent = 0;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}?role=admin&token=${ADMIN_TOKEN}`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[WS] Admin connected to relay server');
    wsConnected = true;
    reconnectAttempts = 0;
    updateConnectionUI(true);
    logEvent('sys', 'Connected to relay server as ADMIN');

    // Start heartbeat (watchdog kick timer)
    clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        lastHeartbeatSent = Date.now();
        ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, 500);
  };

  /**
   * Message dispatcher — routes incoming server messages.
   * Like the main interrupt vector table on ARM Cortex-M.
   */
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error('[WS] Parse error:', err);
    }
  };

  ws.onclose = (event) => {
    console.log(`[WS] Disconnected (code: ${event.code})`);
    wsConnected = false;
    updateConnectionUI(false);
    clearInterval(heartbeatInterval);
    logEvent('err', `Disconnected from server (code: ${event.code})`);
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
  };
}

function scheduleReconnect() {
  const delay = Math.min(500 * Math.pow(2, reconnectAttempts), 10000);
  reconnectAttempts++;
  setTimeout(connect, delay);
}

/* ===========================================================================
 *  MESSAGE HANDLER — Interrupt vector dispatch
 * ========================================================================= */
function handleServerMessage(msg) {
  switch (msg.type) {

    /* ── Initial state sync (like reading all config registers after reset) ── */
    case 'init':
      eStopEngaged = msg.eStopActive || false;
      userInputLocked = msg.userInputLocked || false;
      serialConnected = msg.serialConnected || false;
      activeDriverId = msg.activeDriverId || null;

      updateEstopUI();
      DOM.toggleLockUsers.checked = userInputLocked;
      updateSerialStatusUI(serialConnected);

      if (msg.servoLimits) populateCalibration(msg.servoLimits);
      if (msg.jointState) updateJointReadout(msg.jointState);

      logEvent('sys', `Init complete — E-STOP: ${eStopEngaged}, Lock: ${userInputLocked}, Serial: ${serialConnected}`);
      break;

    case 'auth_request':
      logEvent('sys', `Access requested by ${msg.username}. OTP: ${msg.code}`);
      break;

    case 'driver_assigned':
      activeDriverId = msg.driverId;
      logEvent('sys', `Driver access assigned to ${activeDriverId || 'NONE'}`);
      if (lastKnownClients) updateClientList(lastKnownClients);
      break;

    /* ── Heartbeat ACK — latency measurement ── */
    case 'heartbeat_ack':
      const latency = Date.now() - lastHeartbeatSent;
      DOM.latencyValue.textContent = latency;
      DOM.latencyBadge.style.display = 'inline-flex';
      DOM.latencyBadge.className = `badge ${latency < 50 ? 'badge-green' : latency < 150 ? 'badge-yellow' : 'badge-red'}`;
      break;

    /* ── Periodic telemetry update from server ── */
    case 'telemetry':
      updateTelemetryDisplay(msg.data);
      break;

    /* ── Joint state update (from user or admin) ── */
    case 'joint_update':
      updateJointReadout(msg.data);
      break;

    /* ── Serial TX echo (outgoing to MCU) ── */
    case 'serial_tx':
      appendConsole('tx', msg.data, msg.timestamp);
      break;

    /* ── Serial RX data (incoming from MCU) ── */
    case 'serial_rx':
      appendConsole('rx', msg.data, msg.timestamp);
      pulseSerialHeartbeat();
      break;

    /* ── Serial port list ── */
    case 'serial_ports':
      populatePortSelector(msg.ports, msg.error);
      break;

    /* ── Serial connection status change ── */
    case 'serial_status':
      serialConnected = msg.connected;
      updateSerialStatusUI(msg.connected, msg.port, msg.error);
      logEvent(msg.connected ? 'sys' : 'err',
        msg.connected ? `Serial connected: ${msg.port} @ ${msg.baud}` : `Serial disconnected${msg.error ? ': ' + msg.error : ''}`);
      break;

    case 'serial_error':
      logEvent('err', `Serial error: ${msg.error}`);
      break;

    /* ── E-STOP state broadcast ── */
    case 'estop_state':
      eStopEngaged = msg.active;
      updateEstopUI();
      logEvent(msg.active ? 'err' : 'sys', `E-STOP ${msg.active ? 'ENGAGED' : 'RELEASED'} by ${msg.by}`);
      break;

    /* ── User lock state broadcast ── */
    case 'lock_state':
      userInputLocked = msg.locked;
      DOM.toggleLockUsers.checked = msg.locked;
      logEvent('sys', `User input ${msg.locked ? 'LOCKED' : 'UNLOCKED'} by ${msg.by}`);
      break;

    /* ── Command sent notification ── */
    case 'command_sent':
      logEvent('sys', `CMD: ${msg.command} by ${msg.source} (${msg.sourceRole})`);
      appendConsole('tx', msg.raw, Date.now());
      break;

    /* ── Client connect/disconnect ── */
    case 'client_connected':
      updateClientList(msg.connectedClients);
      logEvent('sys', `Client ${msg.clientId} (${msg.clientRole}) connected`);
      break;

    case 'client_disconnected':
      logEvent('err', `Client ${msg.clientId} disconnected`);
      break;

    /* ── Calibration ACK ── */
    case 'calibration_ack':
      logEvent('sys', 'Calibration limits applied successfully');
      if (msg.limits) populateCalibration(msg.limits);
      break;

    case 'calibration_updated':
      if (msg.limits) populateCalibration(msg.limits);
      break;

    case 'error':
      logEvent('err', `Server error: ${msg.message}`);
      break;

    default:
      break;
  }
}

/* ===========================================================================
 *  CONNECTION UI
 * ========================================================================= */
function updateConnectionUI(connected) {
  DOM.statusPill.className = `status-pill ${connected ? 'connected' : 'disconnected'}`;
  DOM.statusText.textContent = connected ? 'Admin Connected' : 'Disconnected';
  DOM.latencyBadge.style.display = connected ? 'inline-flex' : 'none';
  DOM.uptimeBadge.style.display = connected ? 'inline-flex' : 'none';
}

/* ===========================================================================
 *  E-STOP MANAGER
 * ===========================================================================
 *
 *  The E-STOP is a latching safety mechanism, just like a physical
 *  mushroom-head emergency stop button on industrial equipment.
 *
 *  Behavior:
 *  - Click to ENGAGE: immediately halts all motors (sends neutral + CMD:ESTOP)
 *  - Click again to RELEASE: requires a long-press (2 seconds) for safety
 *
 *  In embedded terms, engaging E-STOP is like:
 *    1. Set fault flag (volatile bool eStopActive = true)
 *    2. Force all PWM outputs to neutral (TIMx_CCRn = NEUTRAL)
 *    3. Disable timer output enable bits
 */

let estopReleaseTimer = null;
let estopReleaseProgress = 0;

DOM.btnEstop.addEventListener('click', () => {
  if (!eStopEngaged) {
    // ENGAGE E-STOP — immediate action
    eStopEngaged = true;
    if (wsConnected) {
      ws.send(JSON.stringify({ type: 'estop', engage: true }));
    }
    updateEstopUI();
  }
  // Release requires long press — handled by mousedown/mouseup below
});

/**
 * Long-press release mechanism — safety interlock.
 * User must hold the button for 2 seconds to release E-STOP.
 * Prevents accidental release (like a two-key nuclear launch interlock).
 */
DOM.btnEstop.addEventListener('mousedown', (e) => {
  if (!eStopEngaged) return; // Only applies when trying to release

  estopReleaseProgress = 0;
  DOM.estopHint.textContent = 'Hold for 2s to RELEASE...';

  estopReleaseTimer = setInterval(() => {
    estopReleaseProgress += 100;
    const pct = Math.min((estopReleaseProgress / 2000) * 100, 100);
    DOM.estopHint.textContent = `Releasing... ${Math.round(pct)}%`;

    if (estopReleaseProgress >= 2000) {
      clearInterval(estopReleaseTimer);
      eStopEngaged = false;
      if (wsConnected) {
        ws.send(JSON.stringify({ type: 'estop', engage: false }));
      }
      updateEstopUI();
    }
  }, 100);
});

DOM.btnEstop.addEventListener('mouseup', cancelEstopRelease);
DOM.btnEstop.addEventListener('mouseleave', cancelEstopRelease);

function cancelEstopRelease() {
  if (estopReleaseTimer) {
    clearInterval(estopReleaseTimer);
    estopReleaseTimer = null;
    estopReleaseProgress = 0;
    if (eStopEngaged) {
      DOM.estopHint.textContent = 'Hold button for 2s to RELEASE E-STOP.';
    }
  }
}

function updateEstopUI() {
  DOM.btnEstop.classList.toggle('engaged', eStopEngaged);

  if (eStopEngaged) {
    DOM.btnEstop.innerHTML = '<span style="font-size: 1.8rem;">🔴</span>ENGAGED';
    DOM.estopHint.textContent = 'Hold button for 2s to RELEASE E-STOP.';
  } else {
    DOM.btnEstop.innerHTML = '<span style="font-size: 1.8rem;">⛔</span>E-STOP';
    DOM.estopHint.textContent = 'Click to ENGAGE emergency stop. All motors halt immediately.';
  }
}

/* ===========================================================================
 *  USER LOCK TOGGLE
 * ========================================================================= */
DOM.toggleLockUsers.addEventListener('change', () => {
  userInputLocked = DOM.toggleLockUsers.checked;
  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'lock_users', locked: userInputLocked }));
  }
  logEvent('sys', `User input ${userInputLocked ? 'LOCKED' : 'UNLOCKED'}`);
});

/* ===========================================================================
 *  SERIAL BRIDGE MANAGER
 * ===========================================================================
 *
 *  This UI module configures the server-side serial port connection.
 *  It's like a UART configuration dialog in an IDE debugger:
 *  - Select port (like choosing which USART peripheral)
 *  - Set baud rate (like BRR register configuration)
 *  - Connect/disconnect (like enabling/disabling the peripheral clock)
 */

/** Populate port selector from server-provided list. */
function populatePortSelector(ports, error) {
  DOM.serialPort.innerHTML = '<option value="">— Select Port —</option>';

  if (error) {
    const opt = document.createElement('option');
    opt.textContent = `Error: ${error}`;
    opt.disabled = true;
    DOM.serialPort.appendChild(opt);
    return;
  }

  for (const port of ports) {
    const opt = document.createElement('option');
    opt.value = port.path;
    opt.textContent = `${port.path} (${port.manufacturer})`;
    DOM.serialPort.appendChild(opt);
  }
}

/** Connect to selected serial port. */
DOM.btnSerialConnect.addEventListener('click', () => {
  const port = DOM.serialPort.value;
  const baud = parseInt(DOM.serialBaud.value);

  if (!port) {
    logEvent('err', 'No serial port selected');
    return;
  }

  if (wsConnected) {
    ws.send(JSON.stringify({
      type: 'serial_config',
      action: 'connect',
      port: port,
      baud: baud,
    }));
    logEvent('sys', `Connecting to ${port} @ ${baud}...`);
  }
});

/** Disconnect serial port. */
DOM.btnSerialDisconnect.addEventListener('click', () => {
  if (wsConnected) {
    ws.send(JSON.stringify({
      type: 'serial_config',
      action: 'disconnect',
    }));
  }
});

/** Refresh port list. */
DOM.btnRefreshPorts.addEventListener('click', () => {
  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'list_ports' }));
    logEvent('sys', 'Refreshing serial port list...');
  }
});

/** Update serial connection status UI. */
function updateSerialStatusUI(connected, port, error) {
  DOM.btnSerialConnect.disabled = connected;
  DOM.btnSerialDisconnect.disabled = !connected;

  if (connected) {
    DOM.serialStatusBadge.className = 'badge badge-green';
    DOM.serialStatusBadge.textContent = 'ONLINE';
    DOM.serialHeartbeat.classList.add('alive');
    DOM.serialHeartbeat.classList.remove('dead');
  } else {
    DOM.serialStatusBadge.className = 'badge badge-red';
    DOM.serialStatusBadge.textContent = error ? 'ERROR' : 'OFFLINE';
    DOM.serialHeartbeat.classList.remove('alive');
    DOM.serialHeartbeat.classList.add('dead');
  }
}

/**
 * Pulse the serial heartbeat LED when RX data arrives.
 * Like a status LED toggle in an ISR — visual confirmation of activity.
 */
let serialHeartbeatTimeout = null;
function pulseSerialHeartbeat() {
  DOM.serialHeartbeat.classList.add('alive');
  DOM.serialHeartbeat.classList.remove('dead');

  clearTimeout(serialHeartbeatTimeout);
  serialHeartbeatTimeout = setTimeout(() => {
    if (!serialConnected) {
      DOM.serialHeartbeat.classList.remove('alive');
      DOM.serialHeartbeat.classList.add('dead');
    }
  }, 1500);
}

/* ===========================================================================
 *  SERIAL CONSOLE — Raw Packet Monitor
 * ===========================================================================
 *
 *  Displays all TX (outgoing to MCU) and RX (incoming from MCU) packets
 *  in a scrolling log with color coding.
 *
 *  Analogous to a logic analyzer or UART sniffer capturing both directions.
 *  - TX (cyan) = data being sent to STM32
 *  - RX (green) = data received from STM32
 *  - ERR (red) = errors
 *  - SYS (yellow) = system events
 *
 *  Implements a circular buffer: old lines are removed when MAX_CONSOLE_LINES
 *  is exceeded, just like a ring buffer in C:
 *    if (writeIdx >= BUFFER_SIZE) writeIdx = 0;
 */

function appendConsole(type, data, timestamp) {
  // Apply filter
  if (consoleFilter !== 'all' && consoleFilter !== type) return;

  const line = document.createElement('div');
  const timeStr = formatTimestamp(timestamp || Date.now());

  line.innerHTML = `<span class="timestamp">[${timeStr}]</span><span class="${type}">[${type.toUpperCase()}] ${escapeHtml(data)}</span>`;

  DOM.consoleOutput.appendChild(line);
  consoleLinesCount++;

  // Enforce circular buffer limit
  while (consoleLinesCount > MAX_CONSOLE_LINES) {
    DOM.consoleOutput.removeChild(DOM.consoleOutput.firstChild);
    consoleLinesCount--;
  }

  // Auto-scroll to bottom (like a terminal with auto-follow)
  DOM.consoleOutput.scrollTop = DOM.consoleOutput.scrollHeight;
}

/** Clear console. */
DOM.btnClearConsole.addEventListener('click', () => {
  DOM.consoleOutput.innerHTML = '<span class="sys">[SYS] Console cleared</span>';
  consoleLinesCount = 1;
});

/** Console filter buttons. */
document.querySelectorAll('[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    consoleFilter = btn.dataset.filter;

    // Update button states
    document.querySelectorAll('[data-filter]').forEach(b => {
      b.className = `btn btn-sm ${b.dataset.filter === consoleFilter ? 'btn-primary' : ''}`;
    });
  });
});

/* ===========================================================================
 *  TELEMETRY DISPLAY
 * ========================================================================= */

function updateTelemetryDisplay(data) {
  if (!data) return;

  // Update stat cards
  DOM.statTxRate.textContent = data.txRate || 0;
  DOM.statRxRate.textContent = data.rxRate || 0;
  DOM.statTxTotal.textContent = data.packetsSentToSerial || 0;
  DOM.statRxTotal.textContent = data.packetsReceivedFromSerial || 0;
  DOM.statUsers.textContent = data.connectedUsers || 0;
  DOM.statAdmins.textContent = data.connectedAdmins || 0;

  // Update uptime
  if (data.uptimeSeconds !== undefined) {
    DOM.uptimeValue.textContent = formatUptime(data.uptimeSeconds);
  }

  // Update client list
  if (data.connectedClients) {
    updateClientList(data.connectedClients);
  }

  // Update auth requests
  if (data.activeAuthRequests) {
    updateAuthRequests(data.activeAuthRequests);
  }

  // Update serial status
  if (data.serialConnected !== undefined) {
    serialConnected = data.serialConnected;
  }
}

/** Update the live joint angle readout display. */
function updateJointReadout(joints) {
  if (!joints) return;

  DOM.jointReadout.innerHTML = '';
  for (const j of JOINT_CONFIG) {
    const val = joints[j.key] !== undefined ? joints[j.key] : '--';
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.innerHTML = `
      <span class="stat-number">${val}°</span>
      <span class="stat-desc">${j.icon} ${j.label}</span>
    `;
    DOM.jointReadout.appendChild(card);
  }

  // Also update the read‑only joystick preview
  if (DOM.previewLeft && DOM.previewRight) {
    drawUserPreview(joints);
  }
}

// ---------------------------------------------------
// User‑input visual preview (read‑only joysticks)
// ---------------------------------------------------
function drawJoystick(canvas, xAngle, yAngle) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width; // assume square
  const center = size / 2;
  const outerRadius = center - 10;
  const knobRadius = 24;

  // Helper to map angle (0‑180) -> normalized -1..+1 -> position
  const norm = (angle) => (angle - 90) / 90; // 0°=>-1, 90°=>0, 180°=>+1
  const knobX = center + norm(xAngle) * outerRadius;
  const knobY = center + norm(yAngle) * outerRadius;

  // Clear canvas
  ctx.clearRect(0, 0, size, size);

  // Outer ring
  ctx.beginPath();
  ctx.arc(center, center, outerRadius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,229,255,0.15)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Crosshair
  ctx.beginPath();
  ctx.moveTo(center, center - outerRadius);
  ctx.lineTo(center, center + outerRadius);
  ctx.moveTo(center - outerRadius, center);
  ctx.lineTo(center + outerRadius, center);
  ctx.strokeStyle = 'rgba(0,229,255,0.07)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Knob shadow
  ctx.beginPath();
  ctx.arc(knobX, knobY, knobRadius + 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,229,255,0.1)';
  ctx.fill();

  // Knob
  const grad = ctx.createRadialGradient(knobX - 4, knobY - 4, 2, knobX, knobY, knobRadius);
  grad.addColorStop(0, 'rgba(0,229,255,0.9)');
  grad.addColorStop(0.6, 'rgba(0,229,255,0.5)');
  grad.addColorStop(1, 'rgba(0,229,255,0.15)');
  ctx.beginPath();
  ctx.arc(knobX, knobY, knobRadius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Border
  ctx.strokeStyle = 'rgba(0,229,255,0.4)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawUserPreview(joints) {
  // Left joystick: J1 (X) & J2 (Y)
  drawJoystick(DOM.previewLeft, joints.J1 ?? 90, joints.J2 ?? 90);
  // Right joystick: J3 (X) & J4 (Y)
  drawJoystick(DOM.previewRight, joints.J3 ?? 90, joints.J4 ?? 90);
}


/** Update connected clients list. */
function updateClientList(clientsList) {
  lastKnownClients = clientsList;
  if (!clientsList || clientsList.length === 0) {
    DOM.clientList.innerHTML = '<div style="color: var(--text-muted); font-size: 0.72rem; font-family: var(--font-mono);">No clients connected</div>';
    return;
  }

  DOM.clientList.innerHTML = '';
  for (const client of clientsList) {
    const item = document.createElement('div');
    item.className = 'client-item';

    const roleBadgeClass = client.role === 'admin' ? 'badge-yellow' : 'badge-cyan';
    const usernameStr = client.username ? ` (${escapeHtml(client.username)})` : '';
    
    // Grant/Revoke button for users
    let actionBtn = '';
    if (client.role === 'user') {
      if (activeDriverId === client.id) {
        actionBtn = `<button class="btn btn-sm btn-danger" onclick="setDriver(null)">Revoke</button>`;
      } else {
        actionBtn = `<button class="btn btn-sm btn-primary" onclick="setDriver('${client.id}')">Grant Control</button>`;
      }
    }

    item.innerHTML = `
      <div style="display:flex; align-items:center; gap:var(--gap-sm);">
        <span class="client-id">${client.id}${usernameStr}</span>
        <span class="badge ${roleBadgeClass}">${client.role}</span>
        ${activeDriverId === client.id ? '<span class="badge badge-green">DRIVER</span>' : ''}
      </div>
      <div>${actionBtn}</div>
    `;
    DOM.clientList.appendChild(item);
  }
}

window.setDriver = function(clientId) {
  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'assign_driver', clientId: clientId }));
  }
};

function updateAuthRequests(requests) {
  if (!requests || requests.length === 0) {
    DOM.authRequestsList.innerHTML = '<div style="color: var(--text-muted); font-size: 0.72rem; font-family: var(--font-mono);">No pending requests</div>';
    return;
  }
  
  DOM.authRequestsList.innerHTML = '';
  for (const req of requests) {
    const item = document.createElement('div');
    item.className = 'client-item';
    item.innerHTML = `
      <span class="client-id">${escapeHtml(req.username)}</span>
      <span class="badge badge-yellow" style="font-size: 1rem; letter-spacing: 2px;">${req.code}</span>
    `;
    DOM.authRequestsList.appendChild(item);
  }
}

/* ===========================================================================
 *  CALIBRATION PANEL
 * ===========================================================================
 *
 *  Per-servo min/max angle limits to prevent mechanical collisions.
 *  Like programming PWM output compare min/max bounds in firmware:
 *    if (angle < SERVO_MIN[n]) angle = SERVO_MIN[n];
 *    if (angle > SERVO_MAX[n]) angle = SERVO_MAX[n];
 */

/** Build the calibration input rows. */
function buildCalibrationPanel(limits) {
  DOM.calibrationPanel.innerHTML = '';

  for (const j of JOINT_CONFIG) {
    const lim = (limits && limits[j.key]) ? limits[j.key] : { min: 0, max: 180 };

    const row = document.createElement('div');
    row.className = 'calibration-row';

    row.innerHTML = `
      <span class="slider-label">${j.icon} ${j.label}</span>
      <div style="display:flex; align-items:center; gap: var(--gap-xs);">
        <span style="font-size:0.65rem; color:var(--text-muted);">MIN</span>
        <input type="number" class="text-input" id="cal_min_${j.key}" min="0" max="180" value="${lim.min}">
      </div>
      <div style="display:flex; align-items:center; gap: var(--gap-xs);">
        <span style="font-size:0.65rem; color:var(--text-muted);">MAX</span>
        <input type="number" class="text-input" id="cal_max_${j.key}" min="0" max="180" value="${lim.max}">
      </div>
    `;

    DOM.calibrationPanel.appendChild(row);
  }
}

/** Populate calibration fields with current limits from server. */
function populateCalibration(limits) {
  // Build if not yet built
  if (DOM.calibrationPanel.children.length === 0) {
    buildCalibrationPanel(limits);
    return;
  }

  for (const j of JOINT_CONFIG) {
    const lim = limits[j.key];
    if (lim) {
      const minInput = document.getElementById(`cal_min_${j.key}`);
      const maxInput = document.getElementById(`cal_max_${j.key}`);
      if (minInput) minInput.value = lim.min;
      if (maxInput) maxInput.value = lim.max;
    }
  }
}

/** Apply calibration — send limits to server. */
DOM.btnApplyCalibration.addEventListener('click', () => {
  const limits = {};

  for (const j of JOINT_CONFIG) {
    const minInput = document.getElementById(`cal_min_${j.key}`);
    const maxInput = document.getElementById(`cal_max_${j.key}`);

    if (minInput && maxInput) {
      let minVal = parseInt(minInput.value) || 0;
      let maxVal = parseInt(maxInput.value) || 180;

      // Sanity check: min must be < max
      if (minVal > maxVal) {
        [minVal, maxVal] = [maxVal, minVal]; // Swap
        minInput.value = minVal;
        maxInput.value = maxVal;
      }

      limits[j.key] = { min: minVal, max: maxVal };
    }
  }

  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'calibration', limits: limits }));
    logEvent('sys', 'Applying calibration limits...');
  }
});

/** Reset calibration to factory defaults. */
DOM.btnResetCalibration.addEventListener('click', () => {
  const defaults = {};
  for (const j of JOINT_CONFIG) {
    defaults[j.key] = { min: 0, max: 180 };
  }

  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'calibration', limits: defaults }));
    logEvent('sys', 'Resetting calibration to defaults (0°–180°)...');
  }
});

/* ===========================================================================
 *  EVENT LOG — System event logger
 * ========================================================================= */

let eventLogCount = 0;

function logEvent(type, message) {
  const line = document.createElement('div');
  const timeStr = formatTimestamp(Date.now());

  line.innerHTML = `<span class="timestamp">[${timeStr}]</span><span class="${type}">${escapeHtml(message)}</span>`;

  DOM.eventLog.appendChild(line);
  eventLogCount++;

  // Circular buffer eviction
  while (eventLogCount > MAX_EVENT_LINES) {
    DOM.eventLog.removeChild(DOM.eventLog.firstChild);
    eventLogCount--;
  }

  DOM.eventLog.scrollTop = DOM.eventLog.scrollHeight;
}

/* ===========================================================================
 *  UTILITY FUNCTIONS
 * ========================================================================= */

/**
 * Format timestamp as HH:MM:SS.mmm.
 * Like reading the RTC and formatting for display.
 */
function formatTimestamp(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms3 = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms3}`;
}

/**
 * Format uptime in human-readable form.
 */
function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * Escape HTML special characters to prevent XSS.
 * Like sanitizing input before writing to a display buffer.
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/* ===========================================================================
 *  INITIALIZATION — Boot sequence
 * ========================================================================= */

(function init() {
  console.log('[BOOT] Admin Dashboard initializing...');

  // 1. Build calibration panel with defaults
  buildCalibrationPanel(null);

  // 2. Initialize joint readout display
  updateJointReadout({ J1: 90, J2: 90, J3: 90, J4: 90, J5: 90, J6: 90 });

  // 3. Connect WebSocket (admin-privileged)
  connect();

  console.log('[BOOT] Admin Dashboard init complete.');
})();
