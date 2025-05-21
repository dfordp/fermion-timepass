import { createServer } from 'http';
import { Server } from 'socket.io';
import { SignalingServer } from './signaling.js';
import { config } from './config.js';

async function startServer() {
  const httpServer = createServer();
  const io = new Server(httpServer, {
    cors: {
      origin: "http://localhost:3000",
      methods: ["GET", "POST"]
    }
  });

  const signalingServer = new SignalingServer(io);
  await signalingServer.initialize();

  httpServer.listen(config.server.port, () => {
    console.log(`Server running on port ${config.server.port}`);
  });
}

startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});