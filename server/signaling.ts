/* eslint-disable @typescript-eslint/no-explicit-any */
import { Server, Socket } from 'socket.io';
import * as mediasoup from 'mediasoup';
import { config } from './config.js';

// Define specific interfaces for different callback types
interface RtpCapabilitiesCallback {
  (data: { rtpCapabilities: mediasoup.types.RtpCapabilities | undefined }): void;
}

interface TransportOptions {
  id: string;
  iceParameters: mediasoup.types.IceParameters;
  iceCandidates: mediasoup.types.IceCandidate[];
  dtlsParameters: mediasoup.types.DtlsParameters;
}

interface TransportCallback {
  (data: Partial<TransportOptions> & { error?: string }): void;
}


export class SignalingServer {
  private io: Server;
  private worker: mediasoup.types.Worker | null = null;
  private router: mediasoup.types.Router | null = null;
  private transports = new Map<string, mediasoup.types.Transport>();
  private producers = new Map<string, mediasoup.types.Producer>();
  private webRtcServer: mediasoup.types.WebRtcServer | null = null;

  constructor(io: Server) {
    this.io = io;
  }

  async initialize() {
    try {
      await this.createWorker();
      await this.createRouter();
      await this.createWebRtcServer();
      this.handleConnections();
      console.log('SignalingServer initialized successfully');
    } catch (error) {
      console.error('Failed to initialize SignalingServer:', error);
      throw error;
    }
  }

  private async createWorker() {
    this.worker = await mediasoup.createWorker(config.mediasoup.worker);
    console.log('Mediasoup worker created');

    this.worker.on('died', () => {
      console.error('Mediasoup worker died, exiting...');
      process.exit(1);
    });
  }

  

  private async createRouter() {
    if (!this.worker) throw new Error('Worker not initialized');
    this.router = await this.worker.createRouter({ 
      mediaCodecs: config.mediasoup.router.mediaCodecs 
    });
    console.log('Mediasoup router created');
  }

  private handleConnections() {
    this.io.on('connection', (socket: Socket) => {
      console.log('Client connected:', socket.id);

      this.setupSocketHandlers(socket);

      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        this.cleanup(socket.id);
      });
    });
  }

  private setupSocketHandlers(socket: Socket) {
    socket.on('getRouterRtpCapabilities', (callback: unknown) => {
    if (typeof callback !== 'function') {
      console.error('getRouterRtpCapabilities: Callback is not a function');
      return;
    }

    try {
      const cb = callback as RtpCapabilitiesCallback;
      cb({ rtpCapabilities: this.router?.rtpCapabilities });
    } catch (error) {
      console.error('Error in getRouterRtpCapabilities:', error);
    }
  });

  socket.on('createProducerTransport', async (_data: unknown, callback: unknown) => {
    if (typeof callback !== 'function') {
      console.error('createProducerTransport: Callback is not a function');
      return;
    }

    try {
      const transport = await this.createWebRtcTransport();
      this.transports.set(socket.id, transport);
      
      const cb = callback as TransportCallback;
      cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (error: any) {
      console.error('Error in createProducerTransport:', error);
      (callback as TransportCallback)({ error: error.message });
    }
  });

  socket.on('connectProducerTransport', async (
    { dtlsParameters }: { dtlsParameters: mediasoup.types.DtlsParameters }, 
    callback?: TransportCallback
  ) => {
    if (typeof callback !== 'function') {
      console.error('connectProducerTransport: Callback is not a function');
      return;
    }

    try {
      const transport = this.transports.get(socket.id);
      if (!transport) throw new Error('Transport not found');

      await transport.connect({ dtlsParameters });
      callback({});
    } catch (error: any) {
      console.error('Error in connectProducerTransport:', error);
      callback({ error: error.message });
    }
  });
}

  private async handleCallback(
    handler: () => Promise<void> | void,
    eventName: string,
    callback?: (data: { error?: string }) => void
  ) {
    try {
      await handler();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      console.error(`Error in ${eventName}:`, error);
      callback?.({ error: error.message });
    }
  }

   private async createWebRtcServer() {
    if (!this.worker) throw new Error('Worker not initialized');
    this.webRtcServer = await this.worker.createWebRtcServer({
      listenInfos: config.mediasoup.webRtcServer.listenInfos
    });
    console.log('WebRTC server created');
  }


  private async createWebRtcTransport() {
    if (!this.router) throw new Error('Router not initialized');
    if (!this.webRtcServer) throw new Error('WebRtcServer not initialized');

    return await this.router.createWebRtcTransport({
      webRtcServer: this.webRtcServer,
      ...config.mediasoup.webRtcTransport
    });
  }

  private cleanup(socketId: string) {
    try {
      const transport = this.transports.get(socketId);
      if (transport) {
        transport.close();
        this.transports.delete(socketId);
      }

      const producerIds = [...this.producers.entries()]
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        .filter(([_, producer]) => producer.appData.socketId === socketId)
        .map(([id]) => id);

      producerIds.forEach(id => {
        const producer = this.producers.get(id);
        if (producer) {
          producer.close();
          this.producers.delete(id);
        }
      });

      console.log(`Cleaned up resources for socket ${socketId}`);
    } catch (error) {
      console.error(`Error cleaning up socket ${socketId}:`, error);
    }
  }
}