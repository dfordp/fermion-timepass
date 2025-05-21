import * as mediasoupClient from 'mediasoup-client';
import { Socket, io } from 'socket.io-client';

type PeerEventCallback = (peerId: string) => void;
type StreamEventCallback = (stream: MediaStream) => void;
type ErrorCallback = (error: Error) => void;
type Role = 'streamer' | 'viewer';

export class WebRTCService {
  private device?: mediasoupClient.Device;
  private socket: Socket;
  private role: Role;
  private producerTransport?: mediasoupClient.Transport;
  private consumerTransports: Map<string, mediasoupClient.Transport>;
  private producers: Map<string, mediasoupClient.Producer>;
  private consumers: Map<string, mediasoupClient.Consumer>;
  
  private peerJoinedCallback?: PeerEventCallback;
  private peerLeftCallback?: PeerEventCallback;
  private remoteStreamCallback?: StreamEventCallback;
  private errorCallback?: ErrorCallback;

  constructor(role: Role) {
    this.role = role;
    this.socket = io('http://localhost:4000');
    this.consumerTransports = new Map();
    this.producers = new Map();
    this.consumers = new Map();
    this.initializeSocket();
  }

  public onPeerJoined(callback: PeerEventCallback) {
    this.peerJoinedCallback = callback;
  }

  public onPeerLeft(callback: PeerEventCallback) {
    this.peerLeftCallback = callback;
  }

  public onRemoteStream(callback: StreamEventCallback) {
    this.remoteStreamCallback = callback;
  }

  public onError(callback: ErrorCallback) {
    this.errorCallback = callback;
  }

  private initializeSocket() {
    this.socket.on('connect', () => {
      console.log('Connected to signaling server');
      
      this.socket.emit('join', { role: this.role }, (error?: string) => {
        if (error) {
          this.handleError(new Error(error));
          return;
        }

        this.socket.emit('getRouterRtpCapabilities', (data: any) => {
          if (data.error) {
            this.handleError(new Error(data.error));
            return;
          }
          this.loadDevice(data.rtpCapabilities);
        });
      });
    });

    this.socket.on('connect_error', (error: Error) => {
      this.handleError(error);
    });

    if (this.role === 'viewer') {
      this.socket.on('streamerPresent', async ({ streamerId }) => {
        console.log('Streamer present:', streamerId);
        if (this.device?.loaded) {
          await this.connectToStreamer(streamerId);
        }
      });

      this.socket.on('producerClosed', ({ consumerId }) => {
        const consumer = this.consumers.get(consumerId);
        if (consumer) {
          consumer.close();
          this.consumers.delete(consumerId);
        }
      });

      this.socket.on('streamerLeft', () => {
        this.cleanup();
      });
    } else {
      this.socket.on('newProducer', async ({ producerId, producerSocketId }) => {
        if (this.device?.loaded) {
          await this.connectConsumer(producerId, producerSocketId);
        }
      });

      this.socket.on('peerLeft', (peerId: string) => {
        if (this.peerLeftCallback) {
          this.peerLeftCallback(peerId);
        }
        this.cleanup(peerId);
      });
    }
  }

  private async loadDevice(routerRtpCapabilities: mediasoupClient.types.RtpCapabilities) {
    try {
      this.device = new mediasoupClient.Device();
      await this.device.load({ routerRtpCapabilities });
      if (this.peerJoinedCallback) {
        this.peerJoinedCallback(this.socket.id);
      }
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  public async startStreaming(stream: MediaStream) {
    if (this.role !== 'streamer') {
      this.handleError(new Error('Only streamers can start streaming'));
      return;
    }

    if (!this.device?.loaded) {
      this.handleError(new Error('Device not loaded'));
      return;
    }

    try {
      await this.createProducerTransport();
      await this.produceStream(stream);
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  private async createProducerTransport() {
    return new Promise<void>((resolve, reject) => {
      this.socket.emit('createProducerTransport', {}, (data: any) => {
        if (data.error) {
          reject(new Error(data.error));
          return;
        }

        try {
          this.producerTransport = this.device!.createSendTransport(data);
          this.handleProducerTransportEvents();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private handleProducerTransportEvents() {
    if (!this.producerTransport) return;

    this.producerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.socket.emit('connectProducerTransport', { dtlsParameters }, (response: any) => {
        if (response.error) {
          errback(new Error(response.error));
          return;
        }
        callback();
      });
    });

    this.producerTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
      this.socket.emit('produce', { kind, rtpParameters }, (response: any) => {
        if (response.error) {
          errback(new Error(response.error));
          return;
        }
        callback({ id: response.id });
      });
    });
  }

  private async produceStream(stream: MediaStream) {
    try {
      const tracks = stream.getTracks();
      for (const track of tracks) {
        if (!this.producerTransport) throw new Error('Producer transport not created');

        const producer = await this.producerTransport.produce({
          track,
          encodings: track.kind === 'video' ? [
            { maxBitrate: 100000 },
            { maxBitrate: 300000 },
            { maxBitrate: 900000 }
          ] : undefined,
          codecOptions: track.kind === 'video' ? {
            videoGoogleStartBitrate: 1000
          } : undefined,
          appData: { trackId: track.id }
        });

        this.producers.set(`${track.kind}-${track.id}`, producer);

        producer.on('transportclose', () => {
          this.producers.delete(`${track.kind}-${track.id}`);
        });
      }
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  private async connectToStreamer(streamerId: string) {
    try {
      const transport = await this.createConsumerTransport();
      this.consumerTransports.set(streamerId, transport);
      await this.connectConsumer(streamerId, transport);
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  private async createConsumerTransport() {
    return new Promise<mediasoupClient.Transport>((resolve, reject) => {
      this.socket.emit('createConsumerTransport', {}, (data: any) => {
        if (data.error) {
          reject(new Error(data.error));
          return;
        }

        try {
          const transport = this.device!.createRecvTransport(data);
          transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            this.socket.emit('connectConsumerTransport', { dtlsParameters }, (response: any) => {
              if (response.error) {
                errback(new Error(response.error));
                return;
              }
              callback();
            });
          });
          resolve(transport);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private async connectConsumer(streamerId: string, transport: mediasoupClient.Transport) {
    this.socket.emit(
      'consume',
      {
        rtpCapabilities: this.device!.rtpCapabilities,
        streamerId
      },
      async (data: any) => {
        if (data.error) {
          this.handleError(new Error(data.error));
          return;
        }

        try {
          const consumer = await transport.consume({
            id: data.id,
            producerId: data.producerId,
            kind: data.kind,
            rtpParameters: data.rtpParameters
          });

          this.consumers.set(consumer.id, consumer);
          const stream = new MediaStream([consumer.track]);
          
          if (this.remoteStreamCallback) {
            this.remoteStreamCallback(stream);
          }

          this.socket.emit('resumeConsumer', { consumerId: consumer.id });

          consumer.on('transportclose', () => {
            this.consumers.delete(consumer.id);
          });

          consumer.on('producerclose', () => {
            this.consumers.delete(consumer.id);
          });
        } catch (error) {
          this.handleError(error as Error);
        }
      }
    );
  }

  private handleError(error: Error) {
    console.error('WebRTC Error:', error);
    if (this.errorCallback) {
      this.errorCallback(error);
    }
  }

  public disconnect() {
    this.producers.forEach(producer => producer.close());
    this.consumers.forEach(consumer => consumer.close());
    this.consumerTransports.forEach(transport => transport.close());
    if (this.producerTransport) {
      this.producerTransport.close();
    }
    this.socket.disconnect();
  }

  public updateAudioState(enabled: boolean) {
    if (this.role !== 'streamer') return;
    this.producers.forEach((producer, key) => {
      if (key.startsWith('audio')) {
        if (enabled) {
          producer.resume();
        } else {
          producer.pause();
        }
      }
    });
  }

  public updateVideoState(enabled: boolean) {
    if (this.role !== 'streamer') return;
    this.producers.forEach((producer, key) => {
      if (key.startsWith('video')) {
        if (enabled) {
          producer.resume();
        } else {
          producer.pause();
        }
      }
    });
  }

  private cleanup(peerId?: string) {
    if (peerId) {
      const transport = this.consumerTransports.get(peerId);
      if (transport) {
        transport.close();
        this.consumerTransports.delete(peerId);
      }

      for (const [consumerId, consumer] of this.consumers.entries()) {
        if (consumer.appData.peerId === peerId) {
          consumer.close();
          this.consumers.delete(consumerId);
        }
      }
    } else {
      this.consumers.forEach(consumer => consumer.close());
      this.consumers.clear();
      this.consumerTransports.forEach(transport => transport.close());
      this.consumerTransports.clear();
    }
  }

  public stopStreaming() {
    if (this.role !== 'streamer') return;
    this.producers.forEach(producer => producer.close());
    this.producers.clear();
    if (this.producerTransport) {
      this.producerTransport.close();
      this.producerTransport = undefined;
    }
  }
}