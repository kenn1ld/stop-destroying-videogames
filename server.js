import { createServer } from 'http';
import { handler } from './build/handler.js';
import { initWebSocket } from './build/lib/ws.js'; // Adjust path after build

const server = createServer(handler);
initWebSocket(server);

const port = process.env.PORT || 3000;
const host = '0.0.0.0'; // Important for Railway

server.listen(port, host, () => {
  console.log(`🚀 Server running on ${host}:${port}`);
  console.log(`📡 WebSocket ready`);
});