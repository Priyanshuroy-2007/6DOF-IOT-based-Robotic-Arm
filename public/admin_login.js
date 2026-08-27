/**
 * Admin Login & Auth Flow Logic
 */

const DOM = {
  btnSubmit: document.getElementById('btnSubmit'),
  codeInput: document.getElementById('codeInput'),
  statusMsg: document.getElementById('statusMsg'),
};

let ws;
let heartbeatInterval;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}?role=login`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    DOM.statusMsg.textContent = 'Connected. Ready for authentication.';
    DOM.statusMsg.className = 'status-msg info';

    // Start heartbeat
    clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, 500);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'auth_success') {
      DOM.statusMsg.textContent = 'Access Granted! Entering Admin Dashboard...';
      DOM.statusMsg.className = 'status-msg info';
      
      if (msg.role === 'admin') {
        sessionStorage.setItem('robotic_arm_admin_token', msg.token);
        setTimeout(() => {
          window.location.href = `/admin.html`;
        }, 500);
      } else {
        DOM.statusMsg.textContent = 'Unexpected Role. Access Denied.';
        DOM.statusMsg.className = 'status-msg error';
      }
    } 
    else if (msg.type === 'auth_fail') {
      DOM.statusMsg.textContent = msg.message || 'Invalid Token.';
      DOM.statusMsg.className = 'status-msg error';
      DOM.codeInput.value = '';
    }
    else if (msg.type === 'error') {
      DOM.statusMsg.textContent = msg.message;
      DOM.statusMsg.className = 'status-msg error';
    }
  };

  ws.onclose = () => {
    DOM.statusMsg.textContent = 'Disconnected from server.';
    DOM.statusMsg.className = 'status-msg error';
    clearInterval(heartbeatInterval);
    setTimeout(connect, 3000); // auto-reconnect
  };
}

// Submit Code
DOM.btnSubmit.addEventListener('click', () => {
  const code = DOM.codeInput.value.trim();
  if (code.length === 0) {
    DOM.statusMsg.textContent = 'Please enter a token.';
    DOM.statusMsg.className = 'status-msg error';
    return;
  }
  
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'submit_code',
      username: 'Priyanshu',
      code: code
    }));
    DOM.statusMsg.textContent = 'Verifying...';
    DOM.statusMsg.className = 'status-msg';
  }
});

// Allow Enter key to trigger code submission
DOM.codeInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') DOM.btnSubmit.click();
});

// Clean up connection on unload to prevent ghost sessions
window.addEventListener('beforeunload', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'Page unloaded');
  }
});

// Boot
(function init() {
  connect();
})();
