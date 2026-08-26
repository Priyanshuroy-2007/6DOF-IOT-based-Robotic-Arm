/**
 * ============================================================================
 *  ROBOTIC ARM CONTROL — User Control Panel (user.js)
 * ============================================================================
 *
 *  This script implements the client-side control logic for the User UI.
 *  Every major section is annotated with its embedded/C paradigm equivalent.
 *
 *  Functional Blocks:
 *  ┌───────────────────────────────────────────────┐
 *  │  WebSocket Client ─── Bidirectional comms     │
 *  │  Virtual Joysticks ─── Canvas pointer input   │
 *  │  Slider Bank ─── 6-axis manual override       │
 *  │  Teach & Replay ─── Frame recording/playback  │
 *  │  State Manager ─── Unified joint struct       │
 *  └───────────────────────────────────────────────┘
 *
 *  Data flow:
 *  Joystick/Slider → jointState → throttledSend() → WebSocket TX → Server
 *  Server → WebSocket RX → updateUI()
 */

'use strict';

/* ===========================================================================
 *  JOINT STATE (analogous to a C struct)
 * ===========================================================================
 *
 *  In embedded C, you'd define this as:
 *    typedef struct {
 *      uint8_t j1;  // Base rotation       (0–180°)
 *      uint8_t j2;  // Shoulder elevation   (0–180°)
 *      uint8_t j3;  // Elbow bend           (0–180°)
 *      uint8_t j4;  // Wrist pitch          (0–180°)
 *      uint8_t j5;  // Wrist roll           (0–180°)
 *      uint8_t j6;  // Gripper open/close   (0–180°)
 *    } JointState_t;
 *
 *  The JS equivalent below uses an object with matching key names.
 *  All values are integers clamped to [0, 180].
 */
const jointState = {
  J1: 90,   // Base — center position
  J2: 90,   // Shoulder
  J3: 90,   // Elbow
  J4: 90,   // Wrist Pitch
  J5: 90,   // Wrist Roll
  J6: 90,   // Gripper
};

/**
 * Joint metadata — defines the label and slider configuration for each axis.
 * Analogous to a peripheral configuration table in C firmware.
 */
const JOINT_CONFIG = [
  { key: 'J1', label: 'Base',         icon: '🔄', min: 0, max: 180 },
  { key: 'J2', label: 'Shoulder',     icon: '💪', min: 0, max: 180 },
  { key: 'J3', label: 'Elbow',        icon: '🦾', min: 0, max: 180 },
  { key: 'J4', label: 'Wrist Pitch',  icon: '↕️', min: 0, max: 180 },
  { key: 'J5', label: 'Wrist Roll',   icon: '↩️', min: 0, max: 180 },
  { key: 'J6', label: 'Gripper',      icon: '✊', min: 0, max: 180 },
];

/* ===========================================================================
 *  WEBSOCKET CLIENT
 * ===========================================================================
 *
 *  Equivalent to a UART TX/RX driver on the MCU.
 *  - connect()      → HAL_UART_Init()
 *  - ws.send()      → HAL_UART_Transmit()
 *  - ws.onmessage   → USART_IRQHandler() / HAL_UART_RxCpltCallback()
 *  - reconnect      → Retry loop (like a comms watchdog reset)
 *
 *  The auto-reconnect uses exponential backoff, similar to how a
 *  CAN bus node backs off after arbitration loss.
 */

let ws = null;                    // Active WebSocket instance
let wsConnected = false;          // Connection state flag (volatile in C)
let reconnectAttempts = 0;        // Backoff counter
const MAX_RECONNECT_DELAY = 10000; // Max backoff: 10 seconds

let myClientId = null;
let currentDriverId = null;
let eStopActive = false;
let userInputLocked = false;

function isDriver() {
  return myClientId && myClientId === currentDriverId;
}

// Heartbeat interval ID — like a recurring timer interrupt
let heartbeatInterval = null;
const HEARTBEAT_RATE = 500;       // Send heartbeat every 500ms

// Latency tracking — measures round-trip time like a ping
let lastHeartbeatSent = 0;
let currentLatency = 0;

// Throttle state — prevents flooding (like SysTick-gated output)
let lastSendTime = 0;
const THROTTLE_MS = 20;           // 50Hz max send rate

/**
 * Establishes WebSocket connection to the relay server.
 * Analogous to initializing a UART peripheral with interrupt-driven RX.
 */
function connect() {
  const urlParams = new URLSearchParams(window.location.search);
  let token = urlParams.get('token') || sessionStorage.getItem('robotic_arm_token');
  
  if (!token) {
    window.location.href = '/login.html';
    return;
  }

  // Store in sessionStorage and clean token from URL
  sessionStorage.setItem('robotic_arm_token', token);
  if (window.location.search.includes('token=')) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}?role=user&token=${token}`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[WS] Connected to relay server');
    wsConnected = true;
    reconnectAttempts = 0;
    updateConnectionUI(true);

    // Start heartbeat timer (like enabling a periodic timer interrupt)
    clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_RATE);
  };

  /**
   * Message handler — main dispatch loop.
   * Like the switch-case inside USART_IRQHandler that routes
   * based on packet type/command byte.
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

    // Safety: Disable physical replay control if disconnected
    if (typeof stopPlayback === 'function') stopPlayback();
    if (typeof isRecording !== 'undefined' && isRecording && typeof stopRecording === 'function') stopRecording();

    if (event.code === 4001) {
      console.warn('[AUTH] Session invalid or expired. Redirecting to login.');
      sessionStorage.removeItem('robotic_arm_token');
      window.location.href = '/login.html';
      return;
    }
    if (event.code === 4029) {
      console.warn('[WS] Rate limit reached. Retrying in 10s...');
      setTimeout(connect, 10000);
      return;
    }

    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
  };
}

/**
 * Exponential backoff reconnection.
 * Delay doubles each attempt: 500ms, 1s, 2s, 4s, ... up to MAX.
 * Similar to CAN bus error recovery with increasing retry intervals.
 */
function scheduleReconnect() {
  const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  setTimeout(connect, delay);
}

/**
 * Send heartbeat — like kicking the watchdog timer (IWDG_KR = 0xAAAA).
 * Also measures round-trip latency.
 */
function sendHeartbeat() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    lastHeartbeatSent = Date.now();
    ws.send(JSON.stringify({ type: 'heartbeat' }));
  }
}

/**
 * Throttled joint state sender.
 * Only sends if enough time has elapsed since the last send.
 * Equivalent to a SysTick-gated DMA transfer trigger.
 */
function sendJointState() {
  if (!wsConnected || !isDriver()) return;

  const now = Date.now();
  if (now - lastSendTime < THROTTLE_MS) return;
  lastSendTime = now;

  ws.send(JSON.stringify({
    type: 'joints',
    data: { ...jointState },
  }));
}

/**
 * Route incoming server messages to appropriate handlers.
 * Analogous to an interrupt vector table dispatch.
 */
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'init':
      myClientId = msg.clientId;
      currentDriverId = msg.activeDriverId;
      eStopActive = !!msg.eStopActive;
      userInputLocked = !!msg.userInputLocked;
      updateDriverUI();
      
      const userDisplay = document.getElementById('usernameDisplay');
      if (userDisplay && msg.username) {
        userDisplay.textContent = '👤 ' + msg.username;
      }

      // Initial state sync from server (like reading config registers after boot)
      if (msg.jointState) {
        Object.assign(jointState, msg.jointState);
        syncSlidersFromState();
      }
      if (eStopActive) showEstopBanner(true);
      if (userInputLocked) showLockBanner(true);
      break;

    case 'driver_assigned':
      currentDriverId = msg.driverId;
      updateDriverUI();
      break;

    case 'heartbeat_ack':
      currentLatency = Date.now() - lastHeartbeatSent;
      updateLatencyUI(currentLatency);
      break;

    case 'estop_state':
      eStopActive = msg.active;
      showEstopBanner(msg.active);
      updateDriverUI();
      break;

    case 'lock_state':
      userInputLocked = msg.locked;
      showLockBanner(msg.locked);
      updateDriverUI();
      break;

    case 'locked':
      // Attempted to send while locked — visual feedback
      flashLockBanner();
      break;

    case 'estop_active':
      flashEstopBanner();
      break;

    case 'calibration_updated':
      // Server sent updated servo limits — update slider ranges
      if (msg.limits) {
        updateSliderLimits(msg.limits);
      }
      break;

    case 'kicked':
      // Admin forcibly logged out this user — redirect to login
      alert('⛔ You have been logged out by the Admin.');
      window.location.href = '/login.html';
      break;

    default:
      // Unknown message type — ignore silently
      break;
  }
}

/* ===========================================================================
 *  UI STATE UPDATERS
 * ========================================================================= */

/** DOM element references — cached for performance (like register pointers). */
const DOM = {
  statusPill:      document.getElementById('statusPill'),
  statusText:      document.getElementById('statusText'),
  latencyBadge:    document.getElementById('latencyBadge'),
  latencyValue:    document.getElementById('latencyValue'),
  driverBadge:     document.getElementById('driverBadge'),
  lockBanner:      document.getElementById('lockBanner'),
  spectatorBanner: document.getElementById('spectatorBanner'),
  estopBanner:     document.getElementById('estopBanner'),
  sliderGroup:     document.getElementById('sliderGroup'),
  framesBody:      document.getElementById('framesBody'),
  frameCount:      document.getElementById('frameCount'),
  replaySpeed:     document.getElementById('replaySpeed'),
  replaySpeedValue:document.getElementById('replaySpeedValue'),
  joystickLeftValues:  document.getElementById('joystickLeftValues'),
  joystickRightValues: document.getElementById('joystickRightValues'),
  // Recording UI elements
  recordingStatus:     document.getElementById('recordingStatus'),
  recordingTimer:      document.getElementById('recordingTimer'),
  recordingFrameCount: document.getElementById('recordingFrameCount'),
  samplingRate:        document.getElementById('samplingRate'),
  samplingRateValue:   document.getElementById('samplingRateValue'),
};

function updateConnectionUI(connected) {
  DOM.statusPill.className = `status-pill ${connected ? 'connected' : 'disconnected'}`;
  DOM.statusText.textContent = connected ? 'Connected' : 'Disconnected';
  DOM.latencyBadge.style.display = connected ? 'inline-flex' : 'none';
  if (connected) {
    updateDriverUI();
  } else {
    DOM.driverBadge.style.display = 'none';
    DOM.spectatorBanner.classList.remove('visible');
  }
}

function updateDriverUI() {
  if (!wsConnected) return;
  const driver = isDriver();
  
  if (driver) {
    DOM.spectatorBanner.innerHTML = '🎮 ACCESS GRANTED — YOU HAVE CONTROL';
    DOM.spectatorBanner.style.borderColor = 'var(--primary-color)';
    DOM.spectatorBanner.style.background = 'rgba(0, 229, 255, 0.05)';
    DOM.spectatorBanner.style.color = 'var(--primary-color)';
  } else {
    DOM.spectatorBanner.innerHTML = '👀 SPECTATOR MODE — WAITING FOR ADMIN TO GRANT DRIVE ACCESS';
    DOM.spectatorBanner.style.borderColor = 'var(--warning-color)';
    DOM.spectatorBanner.style.background = 'rgba(255, 171, 0, 0.05)';
    DOM.spectatorBanner.style.color = 'var(--warning-color)';
  }

  DOM.driverBadge.style.display = driver ? 'inline-flex' : 'none';
  
  // Disable UI elements if not driver or if locked
  const disabled = !driver || userInputLocked || eStopActive;
  for (const joint of JOINT_CONFIG) {
    const el = sliderElements[joint.key];
    if (el) el.slider.disabled = disabled;
  }
}

function updateLatencyUI(ms) {
  DOM.latencyValue.textContent = ms;
  // Color-code: green < 50ms, yellow < 150ms, red >= 150ms
  if (ms < 50) {
    DOM.latencyBadge.className = 'badge badge-green';
  } else if (ms < 150) {
    DOM.latencyBadge.className = 'badge badge-yellow';
  } else {
    DOM.latencyBadge.className = 'badge badge-red';
  }
}

function showLockBanner(locked) {
  DOM.lockBanner.classList.toggle('visible', locked);
}

function showEstopBanner(active) {
  DOM.estopBanner.classList.toggle('visible', active);
}

function flashLockBanner() {
  DOM.lockBanner.classList.add('visible');
  DOM.lockBanner.style.animation = 'none';
  requestAnimationFrame(() => {
    DOM.lockBanner.style.animation = '';
  });
}

function flashEstopBanner() {
  DOM.estopBanner.classList.add('visible');
}

/* ===========================================================================
 *  SLIDER BANK — 6-Axis Manual Override
 * ===========================================================================
 *
 *  Each slider maps to one joint axis, like setting a PWM duty cycle
 *  via an output compare register:
 *    slider.value → jointState.Jn → sendJointState() → server → UART TX
 *
 *  The slider `input` event fires on every drag tick (high frequency),
 *  which is then throttled by sendJointState().
 */

/** Reference map for quick slider access by joint key. */
const sliderElements = {};

/**
 * Build slider DOM elements from JOINT_CONFIG.
 * Like initializing PWM channels in a loop based on a config array.
 */
function buildSliders() {
  DOM.sliderGroup.innerHTML = '';

  for (const joint of JOINT_CONFIG) {
    const row = document.createElement('div');
    row.className = 'slider-row';

    // Label
    const label = document.createElement('span');
    label.className = 'slider-label';
    label.textContent = `${joint.icon} ${joint.label}`;

    // Range slider
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = `slider_${joint.key}`;
    slider.min = joint.min;
    slider.max = joint.max;
    slider.value = jointState[joint.key];
    slider.step = 1;
    // Set CSS custom property for fill visualization
    slider.style.setProperty('--fill', `${(jointState[joint.key] / 180) * 100}%`);

    // Value readout
    const valueSpan = document.createElement('span');
    valueSpan.className = 'slider-value';
    valueSpan.id = `value_${joint.key}`;
    valueSpan.textContent = `${jointState[joint.key]}°`;

    /**
     * Input event — fires on every slider tick (like an ADC conversion
     * complete interrupt that triggers on every sample).
     */
    slider.addEventListener('input', () => {
      const val = parseInt(slider.value);
      jointState[joint.key] = val;
      valueSpan.textContent = `${val}°`;
      slider.style.setProperty('--fill', `${(val / 180) * 100}%`);
      sendJointState();
    });

    sliderElements[joint.key] = { slider, valueSpan };

    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(valueSpan);
    DOM.sliderGroup.appendChild(row);
  }
}

/**
 * Sync slider positions FROM the jointState object.
 * Called when joysticks update the state, or when server sends initial state.
 * Like updating a display register from a shadow register.
 */
function syncSlidersFromState() {
  for (const joint of JOINT_CONFIG) {
    const el = sliderElements[joint.key];
    if (el) {
      el.slider.value = jointState[joint.key];
      el.valueSpan.textContent = `${jointState[joint.key]}°`;
      el.slider.style.setProperty('--fill', `${(jointState[joint.key] / 180) * 100}%`);
    }
  }
}

/**
 * Update slider min/max from calibration data.
 * Like reprogramming PWM compare register bounds.
 */
function updateSliderLimits(limits) {
  for (const joint of JOINT_CONFIG) {
    const el = sliderElements[joint.key];
    if (el && limits[joint.key]) {
      el.slider.min = limits[joint.key].min;
      el.slider.max = limits[joint.key].max;
    }
  }
}

/* ===========================================================================
 *  VIRTUAL JOYSTICK — Pure Canvas Implementation
 * ===========================================================================
 *
 *  Each joystick is a 2-axis input rendered on an HTML5 <canvas>.
 *  This is analogous to reading a dual-axis analog joystick via ADC:
 *
 *    ADC Channel X → Raw value (0–4095) → map() → angle (0–180°)
 *    ADC Channel Y → Raw value (0–4095) → map() → angle (0–180°)
 *
 *  Here, pointer position relative to canvas center gives normalized
 *  coordinates (-1.0 to +1.0), which are then mapped to 0–180°.
 *
 *  Touch events are handled via Pointer Events API for unified
 *  mouse + touch support (like a HAL abstraction layer).
 */

class VirtualJoystick {
  /**
   * @param {string} canvasId   - Canvas element ID
   * @param {string} xJointKey  - Joint key for X axis (e.g., 'J1')
   * @param {string} yJointKey  - Joint key for Y axis (e.g., 'J2')
   * @param {HTMLElement} valueDisplay - Element to show axis values
   */
  constructor(canvasId, xJointKey, yJointKey, valueDisplay) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.xKey = xJointKey;
    this.yKey = yJointKey;
    this.valueDisplay = valueDisplay;

    // Canvas geometry
    this.size = this.canvas.width;
    this.center = this.size / 2;
    this.outerRadius = this.size / 2 - 10;
    this.knobRadius = 24;
    this.deadZone = 5; // Pixels of dead zone at center (like ADC noise floor)

    // Knob state — current position (analogous to ADC sample buffer)
    this.knobX = this.center;
    this.knobY = this.center;
    this.active = false;   // Pointer is down (like a button press flag)
    this.pointerId = null; // Track specific pointer for multi-touch

    // Trail history for visual feedback
    this.trail = [];
    this.maxTrailLength = 12;

    // Bind event handlers (like registering interrupt callbacks)
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointerleave', (e) => this.onPointerUp(e));

    // Initial render
    this.render();
  }

  /**
   * Pointer down — start tracking (like setting a GPIO interrupt flag).
   */
  onPointerDown(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.active = true;
    this.pointerId = e.pointerId;
    this.updateKnobPosition(e);
  }

  /**
   * Pointer move — update knob if active (like polling ADC while conversion flag is set).
   */
  onPointerMove(e) {
    if (!this.active || e.pointerId !== this.pointerId) return;
    e.preventDefault();
    this.updateKnobPosition(e);
  }

  /**
   * Pointer up — release and spring back to center.
   * The spring-back is like a mechanical joystick return spring,
   * or resetting an ADC channel to default sampling.
   */
  onPointerUp(e) {
    if (e.pointerId !== this.pointerId) return;
    this.active = false;
    this.pointerId = null;
    this.trail = [];

    // Animate spring-back to center
    this.springBack();
  }

  /**
   * Update knob position from pointer event.
   * Clamps to circular boundary (like saturation arithmetic in DSP).
   */
  updateKnobPosition(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.size / rect.width;
    const scaleY = this.size / rect.height;

    let x = (e.clientX - rect.left) * scaleX;
    let y = (e.clientY - rect.top) * scaleY;

    // Calculate distance from center
    const dx = x - this.center;
    const dy = y - this.center;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Clamp to outer radius (circular boundary enforcement)
    if (dist > this.outerRadius) {
      const angle = Math.atan2(dy, dx);
      x = this.center + Math.cos(angle) * this.outerRadius;
      y = this.center + Math.sin(angle) * this.outerRadius;
    }

    this.knobX = x;
    this.knobY = y;

    // Add to trail
    this.trail.push({ x, y });
    if (this.trail.length > this.maxTrailLength) {
      this.trail.shift();
    }

    // Convert to normalized values and update joint state
    this.updateJointState();
    this.render();
  }

  /**
   * Map knob position to joint angles.
   *
   * Normalized: (position - center) / radius → [-1.0, +1.0]
   * Then mapped to [0, 180] degrees:
   *   angle = (normalized + 1.0) / 2.0 * 180
   *
   * This mirrors the embedded map() function:
   *   int map(int x, int in_min, int in_max, int out_min, int out_max) {
   *     return (x - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
   *   }
   */
  updateJointState() {
    const normalizedX = (this.knobX - this.center) / this.outerRadius;
    const normalizedY = (this.knobY - this.center) / this.outerRadius;

    // Apply dead zone (like ADC noise threshold)
    const applyDeadZone = (val) => {
      if (Math.abs(val) < this.deadZone / this.outerRadius) return 0;
      return val;
    };

    const dx = applyDeadZone(normalizedX);
    const dy = applyDeadZone(normalizedY);

    // Map to 0–180° (center = 90°)
    const xAngle = Math.round((dx + 1.0) * 90);
    const yAngle = Math.round((dy + 1.0) * 90);

    // Clamp to [0, 180]
    jointState[this.xKey] = Math.max(0, Math.min(180, xAngle));
    jointState[this.yKey] = Math.max(0, Math.min(180, yAngle));

    // Update display
    this.valueDisplay.textContent = `X: ${jointState[this.xKey]}° — Y: ${jointState[this.yKey]}°`;

    // Sync sliders
    syncSlidersFromState();

    // Send to server (throttled)
    sendJointState();
  }

  /**
   * Update knob position visually based on external changes to jointState.
   * Called when keyboard controls update the angles.
   */
  syncKnobFromState() {
    if (this.active) return; // Don't snap if user is actively dragging

    // Reverse map: [0, 180] -> [-1.0, 1.0] -> canvas coordinates
    const normalizedX = (jointState[this.xKey] / 90) - 1.0;
    const normalizedY = (jointState[this.yKey] / 90) - 1.0;

    this.knobX = this.center + (normalizedX * this.outerRadius);
    this.knobY = this.center + (normalizedY * this.outerRadius);

    // Update display text
    this.valueDisplay.textContent = `X: ${jointState[this.xKey]}° — Y: ${jointState[this.yKey]}°`;

    this.render();
  }

  /**
   * Spring-back animation — smoothly returns knob to center.
   * Like a servo returning to neutral with exponential decay.
   */
  springBack() {
    const animate = () => {
      if (this.active) return; // User grabbed again

      const dx = this.center - this.knobX;
      const dy = this.center - this.knobY;

      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
        this.knobX = this.center;
        this.knobY = this.center;
        this.updateJointState();
        this.render();
        return;
      }

      // Exponential decay (like an RC discharge curve)
      this.knobX += dx * 0.2;
      this.knobY += dy * 0.2;

      this.updateJointState();
      this.render();
      requestAnimationFrame(animate);
    };

    requestAnimationFrame(animate);
  }

  /**
   * Render the joystick on canvas.
   * Draws: outer ring, grid lines, trail, knob, and crosshair.
   */
  render() {
    const ctx = this.ctx;
    const c = this.center;
    const r = this.outerRadius;

    // Clear
    ctx.clearRect(0, 0, this.size, this.size);

    // --- Outer ring ---
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.strokeStyle = this.active ? 'rgba(0, 229, 255, 0.5)' : 'rgba(0, 229, 255, 0.15)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // --- Grid lines (crosshair) ---
    ctx.beginPath();
    ctx.moveTo(c, c - r);
    ctx.lineTo(c, c + r);
    ctx.moveTo(c - r, c);
    ctx.lineTo(c + r, c);
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // --- Concentric guide rings ---
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(c, c, (r / 4) * i, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.05)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // --- Trail ---
    if (this.trail.length > 1) {
      for (let i = 1; i < this.trail.length; i++) {
        const alpha = (i / this.trail.length) * 0.4;
        const size = (i / this.trail.length) * 4;
        ctx.beginPath();
        ctx.arc(this.trail[i].x, this.trail[i].y, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0, 229, 255, ${alpha})`;
        ctx.fill();
      }
    }

    // --- Knob shadow ---
    ctx.beginPath();
    ctx.arc(this.knobX, this.knobY, this.knobRadius + 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 229, 255, 0.1)';
    ctx.fill();

    // --- Knob ---
    const gradient = ctx.createRadialGradient(
      this.knobX - 4, this.knobY - 4, 2,
      this.knobX, this.knobY, this.knobRadius
    );
    gradient.addColorStop(0, 'rgba(0, 229, 255, 0.9)');
    gradient.addColorStop(0.6, 'rgba(0, 229, 255, 0.5)');
    gradient.addColorStop(1, 'rgba(0, 229, 255, 0.15)');

    ctx.beginPath();
    ctx.arc(this.knobX, this.knobY, this.knobRadius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Knob border
    ctx.strokeStyle = this.active ? 'rgba(0, 229, 255, 0.9)' : 'rgba(0, 229, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // --- Center dot ---
    ctx.beginPath();
    ctx.arc(this.knobX, this.knobY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    // --- Connection line from center to knob ---
    if (this.active) {
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(this.knobX, this.knobY);
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.2)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

/* ===========================================================================
 *  TEACH & REPLAY MODULE
 * ===========================================================================
 *
 *  This module implements trajectory recording and playback, similar to
 *  how a CNC machine stores G-code positions and replays them.
 *
 *  Data structure:
 *    frames[] = array of { J1, J2, J3, J4, J5, J6, timestamp }
 *
 *  In embedded C, this would be a circular buffer or linked list of
 *  JointState_t structs stored in SRAM or external EEPROM.
 */

let recordedFrames = [];          // Frame storage array (like SRAM buffer)
let isPlaying = false;            // Playback active flag
let isLooping = false;            // Loop mode flag
let playbackIndex = 0;            // Current playback position (like a DMA counter)
let playbackTimer = null;         // setTimeout ID for frame stepping

// Continuous recording state
let isRecording = false;          // Recording active flag
let recordingInterval = null;     // setInterval ID for sampling
let recordingTimerInterval = null;// setInterval ID for updating timer display
let recordingStartTime = 0;       // Timestamp when recording began
const MAX_RECORDING_MS = 2 * 60 * 1000; // 2 minutes max

/**
 * Toggle continuous recording on/off.
 * When recording starts, a timer samples joint state at the configured rate.
 * Auto-stops at 2 minutes.
 */
function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

function startRecording() {
  if (isPlaying) return; // Don't record while playing

  isRecording = true;
  recordingStartTime = Date.now();

  const btnRecord = document.getElementById('btnRecord');
  btnRecord.textContent = '⏹ Stop Recording';
  btnRecord.classList.add('btn-recording');
  btnRecord.classList.remove('btn-primary');

  // Show recording status bar
  DOM.recordingStatus.style.display = 'flex';
  DOM.recordingTimer.textContent = '00:00';
  DOM.recordingFrameCount.textContent = '0 frames';

  // Notify server
  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'command', command: 'RECORD_START' }));
  }

  // Get sampling rate from slider
  const sampleMs = parseInt(DOM.samplingRate.value) || 100;

  // Sample joint state at configured rate
  recordingInterval = setInterval(() => {
    const elapsed = Date.now() - recordingStartTime;

    // Auto-stop at 2 minutes
    if (elapsed >= MAX_RECORDING_MS) {
      stopRecording();
      return;
    }

    const frame = {
      ...jointState,
      timestamp: Date.now(),
      index: recordedFrames.length,
    };
    recordedFrames.push(frame);

    // Update live frame count in status bar
    DOM.recordingFrameCount.textContent = `${recordedFrames.length} frames`;

    updateFramesTable();
    updateFrameCount();
  }, sampleMs);

  // Update timer display every second
  recordingTimerInterval = setInterval(() => {
    const elapsed = Date.now() - recordingStartTime;
    const totalSeconds = Math.floor(elapsed / 1000);
    const mins = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const secs = String(totalSeconds % 60).padStart(2, '0');
    DOM.recordingTimer.textContent = `${mins}:${secs}`;
  }, 1000);

  console.log(`[TEACH] Recording started (sampling every ${sampleMs}ms, max 2min)`);
}

function stopRecording() {
  if (!isRecording) return;

  isRecording = false;
  clearInterval(recordingInterval);
  clearInterval(recordingTimerInterval);
  recordingInterval = null;
  recordingTimerInterval = null;

  const btnRecord = document.getElementById('btnRecord');
  btnRecord.textContent = '⏺ Record';
  btnRecord.classList.remove('btn-recording');
  btnRecord.classList.add('btn-primary');

  // Hide recording status bar
  DOM.recordingStatus.style.display = 'none';

  // Notify server
  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'command', command: 'RECORD_STOP' }));
  }

  console.log(`[TEACH] Recording stopped. ${recordedFrames.length} total frames.`);
}

/**
 * Delete a single frame by index.
 */
function deleteFrame(index) {
  recordedFrames.splice(index, 1);
  // Re-index
  recordedFrames.forEach((f, i) => f.index = i);
  updateFramesTable();
  updateFrameCount();
}

/**
 * Toggle between play and pause.
 */
function togglePlayPause() {
  if (isPlaying) {
    pausePlayback();
  } else {
    playPath();
  }
}

/**
 * Update the play/pause button appearance based on current state.
 */
function updatePlayPauseButton() {
  const btn = document.getElementById('btnPlayPause');
  if (!btn) return;
  if (isPlaying) {
    btn.textContent = '⏸ Pause';
    btn.classList.remove('btn-success');
    btn.classList.add('btn-warning');
  } else {
    btn.textContent = '▶ Play';
    btn.classList.remove('btn-warning');
    btn.classList.add('btn-success');
  }
}

/**
 * Play recorded path once.
 * Resumes from the current playbackIndex (supports pause/resume).
 */
function playPath() {
  if (recordedFrames.length === 0) return;
  if (isPlaying) return;

  isPlaying = true;
  isLooping = false;

  if (playbackIndex >= recordedFrames.length) {
    playbackIndex = 0;
  }

  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'command', command: 'PLAY' }));
  }

  updatePlayPauseButton();
  stepPlayback();
}

/**
 * Loop recorded path continuously.
 * Like DMA circular mode — wraps around when reaching the end.
 */
function loopPath() {
  if (recordedFrames.length === 0) return;
  if (isPlaying) return;

  isPlaying = true;
  isLooping = true;

  if (playbackIndex >= recordedFrames.length) {
    playbackIndex = 0;
  }

  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'command', command: 'LOOP' }));
  }

  updatePlayPauseButton();
  stepPlayback();
}

/**
 * Step to next frame in playback sequence.
 * Uses setTimeout for frame timing (like a timer interrupt triggering DMA).
 */
function stepPlayback() {
  if (!isPlaying) return;

  if (playbackIndex >= recordedFrames.length) {
    if (isLooping) {
      playbackIndex = 0; // Wrap around (circular DMA)
    } else {
      stopPlayback();
      return;
    }
  }

  const frame = recordedFrames[playbackIndex];

  // Apply frame to joint state
  jointState.J1 = frame.J1;
  jointState.J2 = frame.J2;
  jointState.J3 = frame.J3;
  jointState.J4 = frame.J4;
  jointState.J5 = frame.J5;
  jointState.J6 = frame.J6;

  // Update UI and send to server
  syncSlidersFromState();
  sendJointState();

  // Highlight current row in table
  highlightFrameRow(playbackIndex);

  playbackIndex++;

  // Schedule next frame (delay = replay speed slider value)
  const delay = parseInt(DOM.replaySpeed.value) || 100;
  playbackTimer = setTimeout(stepPlayback, delay);
}

/**
 * Pause playback — freezes at current frame.
 * Like halting a DMA transfer mid-sequence.
 */
function pausePlayback() {
  isPlaying = false;
  clearTimeout(playbackTimer);

  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'command', command: 'PAUSE' }));
  }

  updatePlayPauseButton();
}

/**
 * Stop playback and reset index.
 * Like disabling DMA and resetting the counter to 0.
 */
function stopPlayback() {
  isPlaying = false;
  isLooping = false;
  playbackIndex = 0;
  clearTimeout(playbackTimer);

  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'command', command: 'STOP' }));
  }

  clearFrameHighlights();
  updatePlayPauseButton();
}

/**
 * Restart playback from the very beginning.
 * Stops current playback, resets index to 0, then starts playing.
 */
function restartPlayback() {
  if (recordedFrames.length === 0) return;

  // Stop whatever is happening
  isPlaying = false;
  clearTimeout(playbackTimer);
  clearFrameHighlights();
  playbackIndex = 0;

  // Now start fresh
  isPlaying = true;
  // Keep current loop mode

  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'command', command: 'RESTART' }));
  }

  updatePlayPauseButton();
  stepPlayback();
}

/**
 * Clear all recorded frames.
 * Like zeroing out the DMA buffer and resetting write pointer.
 */
function clearFrames() {
  stopPlayback();
  if (isRecording) stopRecording();
  recordedFrames = [];
  updateFramesTable();
  updateFrameCount();

  if (wsConnected) {
    ws.send(JSON.stringify({ type: 'command', command: 'CLEAR' }));
  }
}

/* ---- Teach & Replay UI Updaters ---- */

function updateFrameCount() {
  DOM.frameCount.textContent = `${recordedFrames.length} frame${recordedFrames.length !== 1 ? 's' : ''} recorded`;
}

function updateFramesTable() {
  DOM.framesBody.innerHTML = '';

  for (const frame of recordedFrames) {
    const tr = document.createElement('tr');
    tr.id = `frame_row_${frame.index}`;

    const timeStr = new Date(frame.timestamp).toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    tr.innerHTML = `
      <td>${frame.index + 1}</td>
      <td style="color: var(--text-muted)">${timeStr}</td>
      <td>${frame.J1}°</td>
      <td>${frame.J2}°</td>
      <td>${frame.J3}°</td>
      <td>${frame.J4}°</td>
      <td>${frame.J5}°</td>
      <td>${frame.J6}°</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteFrame(${frame.index})">✕</button></td>
    `;

    DOM.framesBody.appendChild(tr);
  }
}

function highlightFrameRow(index) {
  clearFrameHighlights();
  const row = document.getElementById(`frame_row_${index}`);
  if (row) {
    row.style.background = 'rgba(0, 229, 255, 0.08)';
    row.style.borderLeft = '3px solid var(--accent-cyan)';
  }
}

function clearFrameHighlights() {
  const rows = DOM.framesBody.querySelectorAll('tr');
  rows.forEach(row => {
    row.style.background = '';
    row.style.borderLeft = '';
  });
}

/* ===========================================================================
 *  INITIALIZATION — Boot sequence
 * ===========================================================================
 *  Like the main() function in embedded C — runs once on page load.
 *  Initializes all subsystems in dependency order.
 */

(function init() {
  console.log('[BOOT] Robotic Arm User Control Panel initializing...');

  // 1. Build slider bank (like MX_TIM_PWM_Init for all 6 channels)
  buildSliders();

  // 2. Initialize virtual joysticks (like MX_ADC_Init for dual-channel analog input)
  const joystickLeft = new VirtualJoystick(
    'joystickLeft', 'J1', 'J2', DOM.joystickLeftValues
  );
  const joystickRight = new VirtualJoystick(
    'joystickRight', 'J3', 'J4', DOM.joystickRightValues
  );

  // 3. Bind teach & replay buttons (like GPIO EXTI interrupt callbacks)
  document.getElementById('btnRecord').addEventListener('click', toggleRecording);
  document.getElementById('btnPlayPause').addEventListener('click', togglePlayPause);
  document.getElementById('btnLoop').addEventListener('click', loopPath);
  document.getElementById('btnRestart').addEventListener('click', restartPlayback);
  document.getElementById('btnClear').addEventListener('click', clearFrames);

  // 4. Sampling rate slider
  DOM.samplingRate.addEventListener('input', () => {
    const val = DOM.samplingRate.value;
    DOM.samplingRateValue.textContent = `${val}ms`;
    DOM.samplingRate.style.setProperty('--fill', `${((val - 20) / 480) * 100}%`);
  });

  // 4. Replay speed slider
  DOM.replaySpeed.addEventListener('input', () => {
    const val = DOM.replaySpeed.value;
    DOM.replaySpeedValue.textContent = `${val}ms`;
    DOM.replaySpeed.style.setProperty('--fill', `${((val - 10) / 190) * 100}%`);

    // Send speed change to server
    if (wsConnected) {
      ws.send(JSON.stringify({ type: 'command', command: 'SPEED', value: parseInt(val) }));
    }
  });

  // 5. Connect WebSocket (like HAL_UART_Init + enabling RX interrupt)
  connect();

  // 6. Keyboard controls for joysticks (Simultaneous multi-key support)
  const activeKeys = new Set();
  let currentKeyboardStep = 2;
  const keyboardSpeedSlider = document.getElementById('keyboardSpeed');
  const keyboardSpeedValue = document.getElementById('keyboardSpeedValue');
  
  if (keyboardSpeedSlider) {
    keyboardSpeedSlider.addEventListener('input', () => {
      currentKeyboardStep = parseInt(keyboardSpeedSlider.value);
      if (keyboardSpeedValue) keyboardSpeedValue.textContent = `${currentKeyboardStep}° / tick`;
      keyboardSpeedSlider.style.setProperty('--fill', `${((currentKeyboardStep - 1) / 9) * 100}%`);
    });
  }

  window.addEventListener('keydown', (e) => {
    // Prevent scrolling for arrow keys
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
      e.preventDefault();
    }
    activeKeys.add(e.key.toLowerCase());
  });

  window.addEventListener('keyup', (e) => {
    activeKeys.delete(e.key.toLowerCase());
  });

  function processKeyboardInput() {
    if (!wsConnected || !isDriver() || userInputLocked || eStopActive) return;
    
    let changed = false;
    const step = currentKeyboardStep; // Degrees per tick

    // Left Joystick (J1/J2) - WASD Keys
    if (activeKeys.has('a')) { jointState.J1 = Math.max(0, jointState.J1 - step); changed = true; }
    if (activeKeys.has('d')) { jointState.J1 = Math.min(180, jointState.J1 + step); changed = true; }
    if (activeKeys.has('w')) { jointState.J2 = Math.max(0, jointState.J2 - step); changed = true; }
    if (activeKeys.has('s')) { jointState.J2 = Math.min(180, jointState.J2 + step); changed = true; }

    // Right Joystick (J3/J4) - Arrow Keys
    if (activeKeys.has('arrowleft')) { jointState.J3 = Math.max(0, jointState.J3 - step); changed = true; }
    if (activeKeys.has('arrowright')) { jointState.J3 = Math.min(180, jointState.J3 + step); changed = true; }
    if (activeKeys.has('arrowup')) { jointState.J4 = Math.max(0, jointState.J4 - step); changed = true; }
    if (activeKeys.has('arrowdown')) { jointState.J4 = Math.min(180, jointState.J4 + step); changed = true; }

    if (changed) {
      syncSlidersFromState();
      sendJointState();
      joystickLeft.syncKnobFromState();
      joystickRight.syncKnobFromState();
    }
  }

  // Poll keyboard state at 50Hz
  setInterval(processKeyboardInput, 20);

  console.log('[BOOT] Init complete — all subsystems online.');
})();
