# 🤖 Robotic Arm Web Control Interface

A real-time, browser-based control system for a **6-DOF robotic arm** powered by an **STM32F401CB (BlackPill)** microcontroller. Control the arm remotely from anywhere in the world using WebSockets and Ngrok tunneling.

---

## 📌 Overview

This project bridges a physical 6-joint robotic arm to a web interface via a **Node.js WebSocket server** and a **USB-UART serial bridge**. Users log in with OTP authentication, and an admin controls who gets to drive the arm at any given moment.

```
Browser (User / Admin)
        │
        │  WebSocket (ws://)
        ▼
  Node.js Server (port 3000)
        │
        │  USB Serial (UART)
        ▼
  STM32F401CB (BlackPill)
        │
        │  PWM signals
        ▼
  6x Servo Motors (J1–J6)
```

---

## ✨ Features

### 🔐 Authentication & Access Control
- **OTP-based login** — Users request a one-time password (10-minute TTL) to log in
- **Single-driver model** — Only one user can control the arm at a time; admin grants/revokes access
- **Admin panel** — Separate admin dashboard protected by a token (`?token=roboarm2026`)
- **Force logout** — Admin can remotely log out any connected user, redirecting them back to the login page

### 🕹️ User Control Interface
- **Dual virtual joysticks** — Canvas-rendered joysticks for Base/Shoulder (left) and Elbow/Wrist Pitch (right)
- **Keyboard controls** — Arrow keys control J1/J2; WASD keys control J3/J4
- **6-axis sliders** — Manual override sliders for all 6 joints (Base, Shoulder, Elbow, Wrist Pitch, Wrist Roll, Gripper)
- **Username display** — Logged-in user's name shown in the top-left header
- **Spectator mode** — Users without drive access can watch the arm's state in real time
- **E-Stop banner** — Emergency stop indicator shown when admin halts all movement

### 🎬 Teach & Replay Module
- **Continuous recording** — Press Record to start sampling joint positions at a configurable rate (20ms–500ms); press Stop Recording to end. Auto-stops after 2 minutes
- **Live recording indicator** — Blinking REC badge with elapsed timer and frame count
- **Frame table** — All recorded frames displayed with timestamps and per-joint angles
- **Play / Pause toggle** — Single dynamic button; pausing preserves position so playback resumes exactly where you left off
- **Restart** — Jump back to frame 0 and replay from the beginning
- **Loop mode** — Continuous looping playback
- **Replay speed slider** — Configurable inter-frame delay (10ms–200ms)

### 📡 Admin Dashboard
- **Live client list** — See all connected users and their roles in real time
- **Grant / Revoke** — Give or remove driving access per user
- **⏻ Logout** — Force-disconnect any user; they are redirected to the login page
- **E-Stop control** — Latching emergency stop that halts all motors and locks the UI
- **User input lock** — Lock/unlock user controls without triggering E-Stop
- **Serial bridge config** — Configure COM port and baud rate directly from the browser
- **Calibration panel** — Set per-servo min/max angle limits
- **Joystick preview** — Live preview of the arm's current joint state
- **Telemetry console** — Real-time TX/RX packet log with filtering

### 🌐 Remote Access
- **Ngrok tunneling** — Expose the local server globally with a stable Ngrok URL
- **WebSocket heartbeat** — 1500ms watchdog keeps connections alive and auto-disconnects stale clients

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Firmware** | STM32F401CB (BlackPill), HAL, TIM PWM, UART DMA |
| **IDE** | STM32CubeIDE |
| **Server** | Node.js, Express, `ws` (WebSocket), `serialport` |
| **Frontend** | Vanilla HTML/CSS/JavaScript (no frameworks) |
| **Tunneling** | Ngrok |

---

## 📁 Project Structure

```
RoboticArmWebUI/
├── server.js                  # Node.js WebSocket + HTTP server
├── package.json
├── public/
│   ├── login.html             # OTP login page
│   ├── login.js               # Login logic & WebSocket handshake
│   ├── user.html              # User control panel
│   ├── user.js                # Joystick, sliders, keyboard, Teach & Replay
│   ├── admin.html             # Admin dashboard
│   └── admin.js               # Admin controls, client management, serial bridge
└── Robotic_arm/               # STM32CubeIDE firmware project
    ├── Core/
    │   ├── Inc/               # Header files (main.h, etc.)
    │   └── Src/
    │       └── main.c         # Firmware: UART receive, PWM servo control
    ├── Drivers/
    │   ├── CMSIS/             # ARM CMSIS core headers
    │   └── STM32F4xx_HAL_Driver/
    ├── Robotic_arm.ioc        # CubeMX configuration
    └── STM32F401CBUX_FLASH.ld # Linker script
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js** v18 or later
- **Ngrok** account and CLI installed ([ngrok.com](https://ngrok.com))
- **STM32CubeIDE** (to build and flash firmware)
- A BlackPill (STM32F401CB) connected via USB-UART

### 1. Clone the Repository

```bash
git clone https://github.com/<your-username>/RoboticArmWebUI.git
cd RoboticArmWebUI
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Flash the Firmware

Open `Robotic_arm/` in **STM32CubeIDE**, build the project, and flash it to your BlackPill board.

The firmware expects commands over UART in the format:
```
<J1:90,90,90,90,90,90>
```
where each value is a joint angle in degrees (0–180).

### 4. Start the Server

```bash
node server.js
```

The server will start on **http://localhost:3000**.

### 5. Expose Remotely with Ngrok

In a second terminal:
```bash
ngrok http 3000
```

Copy the `https://...ngrok-free.app` URL and share it with users.

---

## 🌐 Accessing the Interface

| Page | URL |
|---|---|
| Login (Users) | `http://localhost:3000/login.html` |
| User Control | `http://localhost:3000/user.html` |
| Admin Dashboard | `http://localhost:3000/admin.html?token=roboarm2026` |

> **For remote access**, replace `localhost:3000` with your Ngrok URL.

---

## 🔒 Authentication Flow

```
User visits /login.html
        │
        │  Enters username → "Request OTP"
        ▼
Server generates OTP (valid 10 min) → displayed in server console
        │
        │  User enters OTP → "Verify"
        ▼
Server validates → issues session → redirects to /user.html
        │
        │  Admin sees user in client list
        ▼
Admin clicks "Grant Control" → user becomes active driver
```

---

## 🎮 Keyboard Controls (User Page)

| Key | Action |
|---|---|
| `←` `→` | J1 Base (left/right) |
| `↑` `↓` | J2 Shoulder (up/down) |
| `A` `D` | J3 Elbow (left/right) |
| `W` `S` | J4 Wrist Pitch (up/down) |

> Keyboard controls only work when you have been granted drive access by the admin.

---

## 📡 WebSocket Message Protocol

### Client → Server

| Type | Description |
|---|---|
| `init` | Register as user/admin, send username |
| `joint_state` | Send current joint angles (J1–J6) |
| `command` | Send control commands (RECORD_START, PLAY, PAUSE, etc.) |
| `assign_driver` | (Admin) Grant/revoke drive access |
| `kick_client` | (Admin) Force-logout a user |
| `heartbeat` | Keep-alive ping |
| `estop` | Toggle emergency stop |
| `lock_users` | Toggle user input lock |

### Server → Client

| Type | Description |
|---|---|
| `init_ack` | Confirm connection, send current state |
| `joint_state` | Broadcast arm position to all clients |
| `driver_assigned` | Notify who has drive access |
| `kicked` | Tell user they have been logged out by admin |
| `estop_update` | Broadcast E-Stop state |
| `lock_update` | Broadcast lock state |
| `clients_update` | Send connected client list (admin) |

---

## ⚙️ Configuration

Key settings inside `server.js`:

```js
const CONFIG = {
  PORT: 3000,
  ADMIN_TOKEN: 'roboarm2026',   // Change this in production!
  THROTTLE_MS: 20,              // Joint state broadcast rate (50Hz)
  WATCHDOG_MS: 1500,            // Heartbeat timeout
  BAUD_RATE: 115200,            // Default serial baud rate
};
```

---

## 🔧 Hardware Setup

| Component | Detail |
|---|---|
| MCU | STM32F401CBUx (BlackPill) |
| Servos | 6× standard hobby servos (J1–J6) |
| PWM Timers | TIM1, TIM2, TIM3, TIM4 (HAL PWM) |
| UART | USART1 (115200 baud, 8N1) |
| Connection | USB-to-UART adapter (CH340 / CP2102) |

### UART Packet Format (Server → STM32)
```
<J1:angle1,angle2,angle3,angle4,angle5,angle6>
```
Example: `<J1:90,45,120,60,90,30>`

---

## 📄 License

MIT License — free to use, modify and distribute.

---

## 🙏 Acknowledgements

- [STMicroelectronics HAL Library](https://github.com/STMicroelectronics)
- [ws — WebSocket library for Node.js](https://github.com/websockets/ws)
- [serialport — Node.js serial port](https://github.com/serialport/node-serialport)
- [Ngrok](https://ngrok.com) for tunneling
