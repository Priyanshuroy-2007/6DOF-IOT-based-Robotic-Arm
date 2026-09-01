const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000/?role=admin&token=PR29');
ws.on('open', () => console.log('Connected!'));
ws.on('close', (code, reason) => console.log('Closed', code, reason.toString()));
ws.on('error', (err) => console.log('Error', err));
ws.on('message', (msg) => console.log('Msg:', msg.toString()));
