/* eslint-disable @typescript-eslint/no-explicit-any */
import { Server, Socket } from 'socket.io';
import * as mediasoup from 'mediasoup';
import { config } from './config.js';

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
  private webRtcServer: mediasoup.types.WebRtcServer | null = null;
  private transports = new Map<string, mediasoup.types.Transport>();
  private producers = new Map<string, mediasoup.types.Producer>();
  private consumers = new Map<string, mediasoup.types.Consumer>();
  private peers = new Map<string, { role: 'streamer' | 'viewer' }>();

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

  private async createWebRtcServer() {
    if (!this.worker) throw new Error('Worker not initialized');
    this.webRtcServer = await this.worker.createWebRtcServer({
      listenInfos: config.mediasoup.webRtcServer.listenInfos
    });
    console.log('WebRTC server created');
  }

  private handleConnections() {
    this.io.on('connection', (socket: Socket) => {
      console.log('Client connected:', socket.id);

      socket.on('join', ({ role }: { role: 'streamer' | 'viewer' }, callback: (error?: string) => void) => {
        try {
          this.peers.set(socket.id, { role });
          callback();

          if (role === 'viewer') {
            const streamers = this.getActiveStreamers();
            streamers.forEach(streamerId => {
              socket.emit('streamerPresent', { streamerId });
            });
          } else {
            this.io.emit('streamerPresent', { streamerId: socket.id });
          }
        } catch (error: any) {
          callback(error.message);
        }
      });

      this.setupSocketHandlers(socket);

      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        const peer = this.peers.get(socket.id);
        if (peer?.role === 'streamer') {
          socket.broadcast.emit('streamerLeft');
        }
        this.peers.delete(socket.id);
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

    socket.on('produce', async (
      { kind, rtpParameters }: { kind: string; rtpParameters: mediasoup.types.RtpParameters },
      callback: (data: { id: string } | { error: string }) => void
    ) => {
      try {
        const transport = this.transports.get(socket.id);
        if (!transport) throw new Error('Transport not found');

        const producer = await transport.produce({
          kind,
          rtpParameters,
          appData: { socketId: socket.id }
        });

        this.producers.set(producer.id, producer);
        this.notifyNewProducer(socket.id, producer.id);

        producer.on('transportclose', () => {
          this.producers.delete(producer.id);
        });

        callback({ id: producer.id });
      } catch (error: any) {
        console.error('Error in produce:', error);
        callback({ error: error.message });
      }
    });

    socket.on('createConsumerTransport', async (_data: unknown, callback: TransportCallback) => {
      try {
        const transport = await this.createWebRtcTransport();
        this.transports.set(socket.id, transport);
        
        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (error: any) {
        console.error('Error in createConsumerTransport:', error);
        callback({ error: error.message });
      }
    });

    socket.on('connectConsumerTransport', async (
      { dtlsParameters }: { dtlsParameters: mediasoup.types.DtlsParameters }, 
      callback: TransportCallback
    ) => {
      try {
        const transport = this.transports.get(socket.id);
        if (!transport) throw new Error('Transport not found');

        await transport.connect({ dtlsParameters });
        callback({});
      } catch (error: any) {
        console.error('Error in connectConsumerTransport:', error);
        callback({ error: error.message });
      }
    });

    socket.on('consume', async (
      { rtpCapabilities, streamerId }: { rtpCapabilities: mediasoup.types.RtpCapabilities; streamerId: string },
      callback: (data: any) => void
    ) => {
      try {
        const producerIds = [...this.producers.entries()]
          .filter(([_, producer]) => producer.appData.socketId === streamerId)
          .map(([id]) => id);

        if (producerIds.length === 0) {
          console.warn(`No producers found for streamer ${streamerId}, waiting...`);
          
          const onNewProducer = (data: { producerId: string, producerSocketId: string }) => {
            if (data.producerSocketId === streamerId) {
              this.handleConsume(socket, streamerId, rtpCapabilities, callback);
              this.io.removeListener('newProducer', onNewProducer);
            }
          };

          this.io.on('newProducer', onNewProducer);
          return;
        }

        await this.handleConsume(socket, streamerId, rtpCapabilities, callback);
      } catch (error: any) {
        console.error('Error in consume:', error);
        callback({ error: error.message });
      }
    });

    socket.on('resumeConsumer', async ({ consumerId }: { consumerId: string }) => {
      try {
        const consumer = this.consumers.get(consumerId);
        if (!consumer) throw new Error('Consumer not found');
        await consumer.resume();
      } catch (error) {
        console.error('Error resuming consumer:', error);
      }
    });
  }

  private async handleConsume(
    socket: Socket,
    streamerId: string,
    rtpCapabilities: mediasoup.types.RtpCapabilities,
    callback: (data: any) => void
  ) {
    try {
      const transport = this.transports.get(socket.id);
      if (!transport) throw new Error('Transport not found');

      const producerIds = [...this.producers.entries()]
        .filter(([_, producer]) => producer.appData.socketId === streamerId)
        .map(([id]) => id);

      for (const producerId of producerIds) {
        const producer = this.producers.get(producerId);
        if (!producer) continue;

        if (!this.router?.canConsume({ producerId, rtpCapabilities })) {
          console.warn('Cannot consume producer:', producerId);
          continue;
        }

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true
        });

        this.consumers.set(consumer.id, consumer);

        consumer.on('transportclose', () => {
          this.consumers.delete(consumer.id);
        });

        consumer.on('producerclose', () => {
          this.consumers.delete(consumer.id);
          socket.emit('producerClosed', { consumerId: consumer.id });
        });

        callback({
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          type: consumer.type,
          producerPaused: consumer.producerPaused
        });
      }
    } catch (error: any) {
      console.error('Error in handleConsume:', error);
      callback({ error: error.message });
    }
  }

  private notifyNewProducer(socketId: string, producerId: string) {
    const viewers = Array.from(this.peers.entries())
      .filter(([_, peer]) => peer.role === 'viewer')
      .map(([id]) => id);

    viewers.forEach(viewerId => {
      this.io.to(viewerId).emit('newProducer', {
        producerId,
        producerSocketId: socketId
      });
    });
  }

  private async createWebRtcTransport() {
    if (!this.router) throw new Error('Router not initialized');
    if (!this.webRtcServer) throw new Error('WebRtcServer not initialized');

    return await this.router.createWebRtcTransport({
      webRtcServer: this.webRtcServer,
      ...config.mediasoup.webRtcTransport
    });
  }

  private getActiveStreamers(): string[] {
    return Array.from(this.peers.entries())
      .filter(([_, peer]) => peer.role === 'streamer')
      .map(([id]) => id);
  }

  private cleanup(socketId: string) {
    try {
      const transport = this.transports.get(socketId);
      if (transport) {
        transport.close();
        this.transports.delete(socketId);
      }

      const producerIds = [...this.producers.entries()]
        .filter(([_, producer]) => producer.appData.socketId === socketId)
        .map(([id]) => id);

      producerIds.forEach(id => {
        const producer = this.producers.get(id);
        if (producer) {
          producer.close();
          this.producers.delete(id);
        }
      });

      const consumerIds = [...this.consumers.entries()]
        .filter(([_, consumer]) => consumer.appData.socketId === socketId)
        .map(([id]) => id);

      consumerIds.forEach(id => {
        const consumer = this.consumers.get(id);
        if (consumer) {
          consumer.close();
          this.consumers.delete(id);
        }
      });

      console.log(`Cleaned up resources for socket ${socketId}`);
    } catch (error) {
      console.error(`Error cleaning up socket ${socketId}:`, error);
    }
  }
}