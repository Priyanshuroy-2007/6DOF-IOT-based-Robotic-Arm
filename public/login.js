/**
 * Login & Auth Flow Logic
 */

const DOM = {
  step1: document.getElementById('step1'),
  step2: document.getElementById('step2'),
  btnRequest: document.getElementById('btnRequest'),
  btnSubmit: document.getElementById('btnSubmit'),
  btnCancel: document.getElementById('btnCancel'),
  usernameInput: document.getElementById('usernameInput'),
  codeInput: document.getElementById('codeInput'),
  statusMsg: document.getElementById('statusMsg'),
};

let ws;
let currentUsername = '';
let heartbeatInterval;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}?role=login`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    DOM.statusMsg.textContent = 'Connected. Ready to request access.';
    DOM.statusMsg.className = 'status-msg info';
    DOM.btnRequest.disabled = false;

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
      DOM.statusMsg.textContent = 'Access Granted! Entering Lobby...';
      DOM.statusMsg.className = 'status-msg info';
      
      // Save token to session storage
      sessionStorage.setItem('robotic_arm_token', msg.token);
      sessionStorage.setItem('robotic_arm_username', currentUsername);
      
      // Redirect to user interface
      setTimeout(() => {
        window.location.href = `/user.html`;
      }, 500);
    } 
    else if (msg.type === 'auth_fail') {
      DOM.statusMsg.textContent = msg.message || 'Invalid Code.';
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
    DOM.btnRequest.disabled = true;
    clearInterval(heartbeatInterval);
    setTimeout(connect, 3000); // auto-reconnect
  };
}

// Request Access
DOM.btnRequest.addEventListener('click', () => {
  const name = DOM.usernameInput.value.trim();
  if (!name) {
    DOM.statusMsg.textContent = 'Please enter your name.';
    DOM.statusMsg.className = 'status-msg error';
    return;
  }
  
  currentUsername = name;
  
  // Send request to server
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'request_access',
      username: currentUsername
    }));
    
    // Switch UI
    DOM.step1.style.display = 'none';
    DOM.step2.style.display = 'block';
    DOM.statusMsg.textContent = 'Waiting for code...';
    DOM.statusMsg.className = 'status-msg';
    DOM.codeInput.focus();
  }
});

// Allow Enter key to trigger request
DOM.usernameInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') DOM.btnRequest.click();
});

// Submit Code
DOM.btnSubmit.addEventListener('click', () => {
  const code = DOM.codeInput.value.trim();
  if (code.length !== 4) {
    DOM.statusMsg.textContent = 'Code must be 4 digits.';
    DOM.statusMsg.className = 'status-msg error';
    return;
  }
  
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'submit_code',
      username: currentUsername,
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

// Cancel and go back to step 1
DOM.btnCancel.addEventListener('click', () => {
  DOM.step2.style.display = 'none';
  DOM.step1.style.display = 'block';
  DOM.codeInput.value = '';
  DOM.statusMsg.textContent = 'Request cancelled.';
  DOM.statusMsg.className = 'status-msg';
});

// Clean up connection on unload to prevent ghost sessions
window.addEventListener('beforeunload', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'Page unloaded');
  }
});

// Boot
(function init() {
  // If they already have a token, they can just go straight to user.html
  // But we force them to click through if they land here to be safe.
  connect();
})();
