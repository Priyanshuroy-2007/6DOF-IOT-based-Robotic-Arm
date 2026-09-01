/**
 * ============================================================================
 *  ROBOTIC ARM CONTROL — Node.js Real-Time Relay Server
 * ============================================================================
 *
 *  Architecture Overview (maps to embedded concepts):
 *  ─────────────────────────────────────────────────────
 *  This server acts as the "middleware MCU" in a split-brain architecture.
 *  Think of it like a DMA controller sitting between the high-level CPU
 *  (web browsers) and the low-level peripheral bus (STM32 UART).
 *
 *  Functional Blocks:
 *  ┌─────────────────────────────────────────────────────┐
 *  │  Express HTTP ─── Static file server (public/)      │
 *  │  WebSocket Server ─── Role-based client manager     │
 *  │  Serial Bridge ─── UART TX/RX via serialport lib    │
 *  │  Watchdog Timer ─── Heartbeat monitor (like IWDG)   │
 *  │  Packet Router ─── Priority mux + throttle gate     │
 *  └─────────────────────────────────────────────────────┘
 *
 *  Protocol format (delimiter-framed for ring-buffer parsing on STM32):
 *    Joint state: <J1:128,J2:90,J3:180,J4:45,J5:90,J6:0>\n
 *    Commands:    <CMD:ESTOP>, <CMD:PLAY>, <CMD:STOP>, etc.
 */

'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

/* ---------------------------------------------------------------------------
 *  Attempt to load serialport. If not installed or on a system without
 *  native build tools, we gracefully degrade (serial features disabled).
 *  This mirrors the embedded pattern of #ifdef peripheral guards.
 * ------------------------------------------------------------------------ */
let SerialPort, ReadlineParser;
try {
  SerialPort = require('serialport').SerialPort;
  ReadlineParser = require('serialport').ReadlineParser;
} catch (e) {
  console.warn('[SERIAL] serialport module not available — serial bridge disabled.');
  console.warn('[SERIAL] Install with: npm install serialport');
}

/* ===========================================================================
 *  CONFIGURATION (analogous to #define constants in C firmware)
 * ========================================================================= */
const CONFIG = {
  HTTP_PORT:        process.env.PORT || 3000,
  ADMIN_TOKEN:      process.env.ADMIN_TOKEN || 'PR29',

  // Watchdog interval & timeout (ms) — maps to STM32 IWDG prescaler/reload
  WATCHDOG_INTERVAL: 1000,
  HEARTBEAT_TIMEOUT: 10000,

  // Throttle gate — max send rate to serial (50Hz = 20ms period)
  // Like a SysTick-gated output timer on the MCU
  THROTTLE_INTERVAL: 20,

  // Neutral / safe position (sent on E-STOP or total disconnect)
  // Equivalent to the default GPIO state after MCU reset
  NEUTRAL_STATE: { J1: 90, J2: 90, J3: 90, J4: 90, J5: 90, J6: 90 },

  // Default serial config
  DEFAULT_BAUD: 115200,

  // Console log buffer size (circular buffer depth)
  MAX_LOG_LINES: 500,
};

/* ===========================================================================
 *  SERVER STATE (analogous to global volatile variables in C)
 * ========================================================================= */

/**
 * Tracks all connected WebSocket clients.
 * Map<WebSocket, ClientInfo>
 *
 * In embedded terms, this is like a connection table / session registry,
 * similar to how a CAN bus node tracks active node IDs.
 */
const clients = new Map();

/**
 * Global state flags — equivalent to volatile status registers in C.
 * These are checked on every packet routing decision, like reading
 * a status register before performing DMA transfer.
 */
let eStopActive = false;           // Emergency stop latch (like a fault flag)
let userInputLocked = false;       // Admin has taken over (priority inversion)
let serialConnected = false;       // Serial port open state
let serialPortInstance = null;     // Active SerialPort object
let serialParser = null;           // Line parser for incoming UART data

const activeAuthRequests = new Map(); // username -> { code, expiresAt }
const validUserTokens = new Map();    // token -> username
let activeDriverId = null;            // clientId of the single allowed driver

/**
 * Last joint state sent to serial — used for throttle deduplication.
 * Analogous to a shadow register that caches the last DMA write.
 */
let lastJointState = { ...CONFIG.NEUTRAL_STATE };
let lastSerialSendTime = 0;

/**
 * Per-servo calibration limits.
 * Analogous to ADC clamp registers or PWM output compare limits.
 * Default: full 0–180° range.
 */
let servoLimits = {
  J1: { min: 0, max: 180 },
  J2: { min: 0, max: 180 },
  J3: { min: 0, max: 180 },
  J4: { min: 0, max: 180 },
  J5: { min: 0, max: 180 },
  J6: { min: 0, max: 180 },
};

/**
 * Telemetry counters — like DWT cycle counters or performance monitors.
 */
let telemetry = {
  packetsSentToSerial: 0,
  packetsReceivedFromSerial: 0,
  txRate: 0,      // packets/sec sent to serial
  rxRate: 0,      // packets/sec received from serial
  connectedUsers: 0,
  connectedAdmins: 0,
  uptime: Date.now(),
};

// Rate tracking sliding window
let txTimestamps = [];
let rxTimestamps = [];

/* ===========================================================================
 *  EXPRESS HTTP SERVER
 * ========================================================================= */
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Redirect root to login page
app.get('/', (req, res) => {
  res.redirect('/user_login.html');
});

const server = http.createServer(app);

/* ===========================================================================
 *  WEBSOCKET SERVER — Role-based connection manager
 * ========================================================================= */
const wss = new WebSocketServer({ server });

/**
 * Generate a unique client ID — like assigning a CAN bus node address.
 * Uses a simple incrementing counter (overflow-safe for JS numbers).
 */
let clientIdCounter = 0;
function generateClientId() {
  return `client_${++clientIdCounter}`;
}

/**
 * WebSocket connection handler.
 *
 * Maps to an interrupt-driven UART RX handler on the MCU:
 * - New connection = new peripheral coming online
 * - Each message = an interrupt firing with payload
 * - Disconnect = peripheral fault / bus error
 */
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role') || 'user';
  const token = url.searchParams.get('token') || '';

  /* ---- Role validation (like access control / privilege levels in RTOS) ---- */
  if (role === 'admin' && token !== CONFIG.ADMIN_TOKEN) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid admin token' }));
    ws.close(4001, 'Unauthorized');
    return;
  }
  
  if (role === 'user') {
    if (!validUserTokens.has(token)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired user session' }));
      ws.close(4001, 'Unauthorized');
      return;
    }
  }

  const clientInfo = {
    id: generateClientId(),
    role: role,
    username: role === 'user' ? validUserTokens.get(token) : (role === 'admin' ? 'Admin' : 'Guest'),
    lastHeartbeat: Date.now(),
    connectedAt: Date.now(),
    lastSendTime: 0,  // Per-client throttle timestamp
  };

  clients.set(ws, clientInfo);
  updateClientCounts();

  console.log(`[WS] ${clientInfo.id} connected as ${role} (total: ${clients.size})`);

  /* ---- Send initial state to newly connected client ---- */
  ws.send(JSON.stringify({
    type: 'init',
    role: role,
    clientId: clientInfo.id,
    eStopActive: eStopActive,
    userInputLocked: userInputLocked,
    serialConnected: serialConnected,
    activeDriverId: activeDriverId,
    username: clientInfo.username,
    jointState: lastJointState,
    servoLimits: servoLimits,
    telemetry: getTelemetrySnapshot(),
  }));

  // If admin, also send available serial ports
  if (role === 'admin') {
    sendSerialPortList(ws);
  }

  /* ---- Message handler (interrupt service routine equivalent) ---- */
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      clientInfo.lastHeartbeat = Date.now(); // Reset watchdog

      routeMessage(ws, clientInfo, msg);
    } catch (err) {
      console.error(`[WS] Invalid message from ${clientInfo.id}:`, err.message);
    }
  });

  /* ---- Disconnect handler ---- */
  ws.on('close', () => {
    console.log(`[WS] ${clientInfo.id} (${clientInfo.role}) disconnected`);
    clients.delete(ws);
    updateClientCounts();
    broadcastToRole('admin', { type: 'client_disconnected', clientId: clientInfo.id });

    // If active driver disconnects, release the lock
    if (clientInfo.id === activeDriverId) {
      activeDriverId = null;
      console.log('[SAFETY] Active driver disconnected — revoking access');
      broadcastToAll({ type: 'driver_assigned', driverId: null });
    }

    // If all clients disconnected, send neutral to prevent runaway
    if (clients.size === 0) {
      console.log('[SAFETY] All clients disconnected — sending neutral state');
      sendToSerial(formatJointPacket(CONFIG.NEUTRAL_STATE));
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error on ${clientInfo.id}:`, err.message);
  });

  // Notify admins of new connection
  broadcastToRole('admin', {
    type: 'client_connected',
    clientId: clientInfo.id,
    clientRole: role,
    connectedClients: getClientList(),
  });
});

/* ===========================================================================
 *  MESSAGE ROUTER — Priority multiplexer
 * ===========================================================================
 *  This function acts like an interrupt priority controller (NVIC in ARM).
 *  Admin messages have higher priority (lower NVIC number) and always
 *  get through. User messages are filtered by lock state and throttled.
 */
function routeMessage(ws, clientInfo, msg) {
  switch (msg.type) {

    /* ---- Heartbeat (watchdog kick) ---- */
    case 'heartbeat':
      ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
      break;

    /* ---- Login Auth Flow ---- */
    case 'request_access':
      if (clientInfo.role === 'login') {
        const username = msg.username;
        if (!username) return;
        const code = Math.floor(1000 + Math.random() * 9000).toString(); // 4 digits
        activeAuthRequests.set(username, { code, expiresAt: Date.now() + 10 * 60 * 1000 });
        
        console.log(`[AUTH] Request from ${username}, code: ${code}`);
        // Broadcast to admins to display in the dashboard
        broadcastToRole('admin', { type: 'auth_request', username: username, code: code });
      }
      break;

    case 'submit_code':
      if (clientInfo.role === 'login') {
        
        // --- ADMIN BYPASS ---
        if (msg.username.trim().toLowerCase() === 'priyanshu' && msg.code === CONFIG.ADMIN_TOKEN) {
          ws.send(JSON.stringify({ type: 'auth_success', token: CONFIG.ADMIN_TOKEN, role: 'admin' }));
          console.log(`[AUTH] Admin ${msg.username} authenticated successfully.`);
          // If there was a pending code for this user, clear it
          activeAuthRequests.delete(msg.username);
          return;
        }

        const req = activeAuthRequests.get(msg.username);
        if (req && req.code === msg.code && Date.now() < req.expiresAt) {
          activeAuthRequests.delete(msg.username);
          const sessionToken = 'usr_' + Math.random().toString(36).substr(2, 12);
          validUserTokens.set(sessionToken, msg.username);
          ws.send(JSON.stringify({ type: 'auth_success', token: sessionToken }));
          console.log(`[AUTH] User ${msg.username} authenticated successfully.`);
        } else {
          ws.send(JSON.stringify({ type: 'auth_fail', message: 'Invalid or expired code.' }));
        }
      }
      break;

    /* ---- Joint state update from user ---- */
    case 'joints':
      if (clientInfo.role === 'user') {
        // Only active driver can send joints
        if (activeDriverId !== clientInfo.id) {
          return; // Silently drop (handled client-side mostly)
        }
        
        // Check if user input is locked by admin
        if (userInputLocked) {
          ws.send(JSON.stringify({ type: 'locked', message: 'Admin has locked user input' }));
          return;
        }
        // Check E-STOP
        if (eStopActive) {
          ws.send(JSON.stringify({ type: 'estop_active', message: 'E-STOP engaged' }));
          return;
        }

        // Throttle gate — like a timer-gated output
        const now = Date.now();
        if (now - clientInfo.lastSendTime < CONFIG.THROTTLE_INTERVAL) {
          return; // Drop packet (rate limited)
        }
        clientInfo.lastSendTime = now;
      }

      // Clamp values to calibration limits (like PWM compare register bounds)
      const clamped = clampJointState(msg.data);
      lastJointState = clamped;

      // Format and send to serial
      const packet = formatJointPacket(clamped);
      sendToSerial(packet);

      // Broadcast to all clients for monitoring and syncing UI
      broadcastToAll({
        type: 'joint_update',
        source: clientInfo.id,
        sourceRole: clientInfo.role,
        data: clamped,
        raw: packet,
      });
      break;

    /* ---- Command messages ---- */
    case 'command':
      handleCommand(ws, clientInfo, msg);
      break;

    /* ---- E-STOP (admin only) ---- */
    case 'estop':
      if (clientInfo.role !== 'admin') return;

      eStopActive = msg.engage !== false; // default to engage
      console.log(`[SAFETY] E-STOP ${eStopActive ? 'ENGAGED' : 'RELEASED'} by ${clientInfo.id}`);

      if (eStopActive) {
        // Immediately send neutral position
        const neutralPacket = formatJointPacket(CONFIG.NEUTRAL_STATE);
        sendToSerial(neutralPacket);
        sendToSerial('<CMD:ESTOP>\n');
        lastJointState = { ...CONFIG.NEUTRAL_STATE };
      }

      // Broadcast E-STOP state to ALL clients
      broadcastToAll({
        type: 'estop_state',
        active: eStopActive,
        by: clientInfo.id,
      });
      break;

    /* ---- Lock user input toggle (admin only) ---- */
    case 'lock_users':
      if (clientInfo.role !== 'admin') return;

      userInputLocked = !!msg.locked;
      console.log(`[ADMIN] User input ${userInputLocked ? 'LOCKED' : 'UNLOCKED'} by ${clientInfo.id}`);

      broadcastToAll({
        type: 'lock_state',
        locked: userInputLocked,
        by: clientInfo.id,
      });
      break;

    /* ---- Assign/Revoke Driver Access (admin only) ---- */
    case 'assign_driver':
      if (clientInfo.role !== 'admin') return;
      activeDriverId = msg.clientId; // null to revoke all
      console.log(`[ADMIN] Driver access assigned to ${activeDriverId || 'NONE'} by ${clientInfo.id}`);
      broadcastToAll({ type: 'driver_assigned', driverId: activeDriverId });
      break;

    /* ---- Kick (disconnect) a client (admin only) ---- */
    case 'kick_client': {
      if (clientInfo.role !== 'admin') return;
      const targetId = msg.clientId;
      let kicked = false;
      for (const [clientWs, info] of clients.entries()) {
        if (info.id === targetId) {
          console.log(`[ADMIN] Logging out client ${info.id} (${info.username || info.role}) — by ${clientInfo.id}`);
          if (activeDriverId === info.id) {
            activeDriverId = null;
            broadcastToAll({ type: 'driver_assigned', driverId: null });
          }
          try {
            clientWs.send(JSON.stringify({ type: 'kicked', reason: 'You have been logged out by the Admin.' }));
          } catch(e) {}
          // Small delay so message is sent before closing
          setTimeout(() => clientWs.close(1000, 'Logged out by admin'), 200);
          kicked = true;
          break;
        }
      }
      if (!kicked) {
        console.warn(`[ADMIN] Logout failed — client ${targetId} not found`);
      }
      break;
    }

    /* ---- Serial port configuration (admin only) ---- */
    case 'serial_config':
      if (clientInfo.role !== 'admin') return;
      handleSerialConfig(ws, msg);
      break;

    /* ---- Request serial port list (admin only) ---- */
    case 'list_ports':
      if (clientInfo.role !== 'admin') return;
      sendSerialPortList(ws);
      break;

    /* ---- Calibration limits update (admin only) ---- */
    case 'calibration':
      if (clientInfo.role !== 'admin') return;
      handleCalibration(ws, msg);
      break;

    default:
      console.warn(`[WS] Unknown message type: ${msg.type} from ${clientInfo.id}`);
  }
}

/* ===========================================================================
 *  COMMAND HANDLER
 * ========================================================================= */
function handleCommand(ws, clientInfo, msg) {
  const cmd = msg.command;
  let serialCmd = '';

  switch (cmd) {
    case 'RECORD':
      serialCmd = '<CMD:RECORD>\n';
      break;
    case 'PLAY':
      serialCmd = '<CMD:PLAY>\n';
      break;
    case 'STOP':
      serialCmd = '<CMD:STOP>\n';
      break;
    case 'LOOP':
      serialCmd = '<CMD:LOOP>\n';
      break;
    case 'PAUSE':
      serialCmd = '<CMD:PAUSE>\n';
      break;
    case 'CLEAR':
      serialCmd = '<CMD:CLEAR>\n';
      break;
    case 'SPEED':
      serialCmd = `<CMD:SPEED:${Math.round(msg.value || 50)}>\n`;
      break;
    default:
      console.warn(`[CMD] Unknown command: ${cmd}`);
      return;
  }

  sendToSerial(serialCmd);

  // Echo command to admin console
  broadcastToRole('admin', {
    type: 'command_sent',
    command: cmd,
    source: clientInfo.id,
    sourceRole: clientInfo.role,
    raw: serialCmd.trim(),
  });
}

/* ===========================================================================
 *  SERIAL PORT BRIDGE
 * ===========================================================================
 *  This module manages the UART connection to the host laptop's USB-serial
 *  adapter. It's analogous to the HAL_UART peripheral driver on the STM32.
 *
 *  Data flow:
 *    sendToSerial(packet) → serialPortInstance.write() → USB → STM32 RX
 *    STM32 TX → USB → serialParser 'data' event → broadcastToRole('admin')
 */

async function sendSerialPortList(ws) {
  if (!SerialPort) {
    ws.send(JSON.stringify({
      type: 'serial_ports',
      ports: [],
      error: 'serialport module not available',
    }));
    return;
  }

  try {
    const ports = await SerialPort.list();
    ws.send(JSON.stringify({
      type: 'serial_ports',
      ports: ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || 'Unknown',
        vendorId: p.vendorId || '',
        productId: p.productId || '',
      })),
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'serial_ports',
      ports: [],
      error: err.message,
    }));
  }
}

function handleSerialConfig(ws, msg) {
  if (!SerialPort) {
    ws.send(JSON.stringify({ type: 'serial_status', connected: false, error: 'serialport module not available' }));
    return;
  }

  const action = msg.action; // 'connect' or 'disconnect'

  if (action === 'disconnect') {
    closeSerial();
    ws.send(JSON.stringify({ type: 'serial_status', connected: false }));
    broadcastToAll({ type: 'serial_status', connected: false });
    return;
  }

  if (action === 'connect') {
    const portPath = msg.port;
    const baudRate = parseInt(msg.baud) || CONFIG.DEFAULT_BAUD;

    if (!portPath) {
      ws.send(JSON.stringify({ type: 'serial_status', connected: false, error: 'No port specified' }));
      return;
    }

    // Close existing connection first
    closeSerial();

    try {
      serialPortInstance = new SerialPort({
        path: portPath,
        baudRate: baudRate,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
      });

      // Use ReadlineParser to parse newline-delimited responses from STM32
      serialParser = serialPortInstance.pipe(new ReadlineParser({ delimiter: '\n' }));

      serialPortInstance.on('open', () => {
        serialConnected = true;
        console.log(`[SERIAL] Opened ${portPath} at ${baudRate} baud`);

        broadcastToAll({ type: 'serial_status', connected: true, port: portPath, baud: baudRate });
      });

      /**
       * Serial RX handler — equivalent to USART1_IRQHandler on STM32.
       * Each line received is a feedback packet from the MCU.
       */
      serialParser.on('data', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        telemetry.packetsReceivedFromSerial++;
        rxTimestamps.push(Date.now());

        // Forward raw serial data to all admin consoles
        broadcastToRole('admin', {
          type: 'serial_rx',
          data: trimmed,
          timestamp: Date.now(),
        });
      });

      serialPortInstance.on('error', (err) => {
        console.error(`[SERIAL] Error: ${err.message}`);
        serialConnected = false;
        broadcastToAll({ type: 'serial_status', connected: false, error: err.message });
      });

      serialPortInstance.on('close', () => {
        console.log('[SERIAL] Port closed');
        serialConnected = false;
        broadcastToAll({ type: 'serial_status', connected: false });
      });

    } catch (err) {
      console.error(`[SERIAL] Failed to open ${portPath}: ${err.message}`);
      ws.send(JSON.stringify({ type: 'serial_status', connected: false, error: err.message }));
    }
  }
}

function closeSerial() {
  if (serialPortInstance && serialPortInstance.isOpen) {
    try {
      serialPortInstance.close();
    } catch (e) {
      console.warn('[SERIAL] Error closing port:', e.message);
    }
  }
  serialPortInstance = null;
  serialParser = null;
  serialConnected = false;
}

/**
 * Send data to serial port (UART TX).
 *
 * Equivalent to HAL_UART_Transmit() on STM32.
 * If serial is not connected, the packet is silently dropped
 * (like writing to a disconnected peripheral — data goes to /dev/null).
 */
function sendToSerial(data) {
  if (serialPortInstance && serialPortInstance.isOpen) {
    serialPortInstance.write(data, (err) => {
      if (err) {
        console.error('[SERIAL] TX error:', err.message);
        broadcastToRole('admin', { type: 'serial_error', error: err.message });
      }
    });

    telemetry.packetsSentToSerial++;
    txTimestamps.push(Date.now());
  }

  // Always log TX to admin console (even if serial disconnected)
  console.log(`[SERIAL TX] ${data.trim()}`); // Print to terminal
  broadcastToRole('admin', {
    type: 'serial_tx',
    data: data.trim(),
    timestamp: Date.now(),
    serialConnected: serialConnected,
  });
}

/* ===========================================================================
 *  PACKET FORMATTING
 * ===========================================================================
 *  Converts JS object to delimiter-framed string for STM32 UART parsing.
 *
 *  Format: <J1:val,J2:val,J3:val,J4:val,J5:val,J6:val>\n
 *
 *  On the STM32 side, the parser would:
 *  1. Wait for '<' start delimiter
 *  2. Buffer characters until '>' end delimiter
 *  3. Parse comma-separated key:value pairs
 *  4. Apply values to PWM output compare registers
 */
function formatJointPacket(joints) {
  return `<J1:${joints.J1},J2:${joints.J2},J3:${joints.J3},J4:${joints.J4},J5:${joints.J5},J6:${joints.J6}>\n`;
}

/**
 * Clamp joint values to calibration limits.
 *
 * Equivalent to clamping ADC/PWM values in firmware:
 *   if (val < min) val = min;
 *   if (val > max) val = max;
 */
function clampJointState(joints) {
  const clamped = {};
  for (const key of ['J1', 'J2', 'J3', 'J4', 'J5', 'J6']) {
    const val = parseInt(joints[key]) || 90;
    const limit = servoLimits[key];
    clamped[key] = Math.max(limit.min, Math.min(limit.max, val));
  }
  return clamped;
}

/* ===========================================================================
 *  CALIBRATION HANDLER
 * ========================================================================= */
function handleCalibration(ws, msg) {
  if (msg.limits) {
    for (const key of ['J1', 'J2', 'J3', 'J4', 'J5', 'J6']) {
      if (msg.limits[key]) {
        servoLimits[key] = {
          min: Math.max(0, parseInt(msg.limits[key].min) || 0),
          max: Math.min(180, parseInt(msg.limits[key].max) || 180),
        };
      }
    }
    console.log('[CALIBRATION] Updated servo limits:', JSON.stringify(servoLimits));

    // Broadcast new limits to all clients
    broadcastToAll({
      type: 'calibration_updated',
      limits: servoLimits,
    });

    ws.send(JSON.stringify({ type: 'calibration_ack', limits: servoLimits }));
  }
}

/* ===========================================================================
 *  BROADCAST UTILITIES
 * ========================================================================= */

/** Broadcast to all connected clients (like a CAN bus broadcast frame). */
function broadcastToAll(msg) {
  const data = JSON.stringify(msg);
  for (const [ws, info] of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  }
}

/** Broadcast only to clients of a specific role (like filtered CAN ID reception). */
function broadcastToRole(role, msg) {
  const data = JSON.stringify(msg);
  for (const [ws, info] of clients) {
    if (info.role === role && ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  }
}

/** Get list of connected clients for admin dashboard. */
function getClientList() {
  const list = [];
  for (const [ws, info] of clients) {
    list.push({
      id: info.id,
      role: info.role,
      username: info.username,
      connectedAt: info.connectedAt,
      lastHeartbeat: info.lastHeartbeat,
    });
  }
  return list;
}

/** Update telemetry client counts. */
function updateClientCounts() {
  telemetry.connectedUsers = 0;
  telemetry.connectedAdmins = 0;
  for (const [ws, info] of clients) {
    if (info.role === 'user') telemetry.connectedUsers++;
    if (info.role === 'admin') telemetry.connectedAdmins++;
  }
}

/** Telemetry snapshot for admin dashboard. */
function getTelemetrySnapshot() {
  return {
    ...telemetry,
    eStopActive,
    userInputLocked,
    serialConnected,
    activeDriverId,
    servoLimits,
    uptimeSeconds: Math.floor((Date.now() - telemetry.uptime) / 1000),
    connectedClients: getClientList(),
    activeAuthRequests: Array.from(activeAuthRequests.entries()).map(([u, d]) => ({ username: u, code: d.code })),
  };
}

/* ===========================================================================
 *  WATCHDOG TIMER
 * ===========================================================================
 *  Runs periodically to check client heartbeats, like the Independent
 *  Watchdog (IWDG) on STM32 that resets the MCU if not kicked in time.
 *
 *  If a client's heartbeat exceeds HEARTBEAT_TIMEOUT:
 *  - Mark as stale / force disconnect
 *  - If all controllers gone, send neutral position (fail-safe)
 *
 *  Also calculates packet rate (Hz) over a 1-second sliding window.
 */
setInterval(() => {
  const now = Date.now();

  /* ---- Check heartbeats ---- */
  for (const [ws, info] of clients) {
    if (now - info.lastHeartbeat > CONFIG.HEARTBEAT_TIMEOUT) {
      console.warn(`[WATCHDOG] ${info.id} heartbeat timeout — disconnecting`);
      ws.close(4002, 'Heartbeat timeout');
      clients.delete(ws);
      updateClientCounts();
    }
  }

  /* ---- Calculate TX/RX rates (packets per second) ---- */
  const oneSecAgo = now - 1000;
  txTimestamps = txTimestamps.filter(t => t > oneSecAgo);
  rxTimestamps = rxTimestamps.filter(t => t > oneSecAgo);
  telemetry.txRate = txTimestamps.length;
  telemetry.rxRate = rxTimestamps.length;

  /* ---- Broadcast telemetry to admins ---- */
  broadcastToRole('admin', {
    type: 'telemetry',
    data: getTelemetrySnapshot(),
  });

}, CONFIG.WATCHDOG_INTERVAL);

/* ===========================================================================
 *  START SERVER
 * ========================================================================= */
server.listen(CONFIG.HTTP_PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   🤖  ROBOTIC ARM CONTROL SERVER                       ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║   HTTP  → http://localhost:${CONFIG.HTTP_PORT}                      ║`);
  console.log(`║   User  → http://localhost:${CONFIG.HTTP_PORT}/user.html             ║`);
  console.log(`║   Admin → http://localhost:${CONFIG.HTTP_PORT}/admin.html?token=${CONFIG.ADMIN_TOKEN}  ║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║   Throttle: ${1000 / CONFIG.THROTTLE_INTERVAL}Hz  |  Watchdog: ${CONFIG.HEARTBEAT_TIMEOUT}ms timeout    ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
});

/* ---- Graceful shutdown ---- */
process.on('SIGINT', () => {
  console.log('\n[SERVER] Shutting down...');
  closeSerial();

  // Send neutral to all connected serials before exit
  if (serialPortInstance && serialPortInstance.isOpen) {
    serialPortInstance.write(formatJointPacket(CONFIG.NEUTRAL_STATE));
  }

  wss.close(() => {
    server.close(() => {
      console.log('[SERVER] Goodbye!');
      process.exit(0);
    });
  });
});
