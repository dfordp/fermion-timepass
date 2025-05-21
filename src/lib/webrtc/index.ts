/* eslint-disable @typescript-eslint/no-explicit-any */
import * as mediasoupClient from 'mediasoup-client';
import { Socket, io } from 'socket.io-client';

type PeerEventCallback = (peerId: string) => void;
type StreamEventCallback = (stream: MediaStream) => void;
type ErrorCallback = (error: Error) => void;

export class WebRTCService {
  private device?: mediasoupClient.Device;
  private socket: Socket;
  private producerTransport?: mediasoupClient.Transport;
  private consumerTransports: Map<string, mediasoupClient.Transport>;
  private producers: Map<string, mediasoupClient.Producer>;
  private consumers: Map<string, mediasoupClient.Consumer>;
  
  private peerJoinedCallback?: PeerEventCallback;
  private peerLeftCallback?: PeerEventCallback;
  private remoteStreamCallback?: StreamEventCallback;
  private errorCallback?: ErrorCallback;

  constructor() {
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
      this.socket.emit('getRouterRtpCapabilities', (data: any) => {
        if (data.error) {
          this.handleError(new Error(data.error));
          return;
        }
        this.loadDevice(data.rtpCapabilities);
      });
    });

    this.socket.on('connect_error', (error: Error) => {
      this.handleError(error);
    });

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
          } : undefined
        });

        this.producers.set(track.kind, producer);

        producer.on('transportclose', () => {
          this.producers.delete(track.kind);
        });
      }
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  private async consume(producerId: string, producerSocketId: string, consumerTransport: mediasoupClient.Transport) {
    this.socket.emit(
      'consume',
      {
        rtpCapabilities: this.device!.rtpCapabilities,
        producerId,
        producerSocketId
      },
      async (data: any) => {
        if (data.error) {
          this.handleError(new Error(data.error));
          return;
        }

        try {
          const consumer = await consumerTransport.consume(data);
          this.consumers.set(producerSocketId, consumer);

          const stream = new MediaStream([consumer.track]);
          if (this.remoteStreamCallback) {
            this.remoteStreamCallback(stream);
          }
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
    const audioProducer = this.producers.get('audio');
    if (audioProducer) {
      if (enabled) {
        audioProducer.resume();
      } else {
        audioProducer.pause();
      }
    }
  }

  public updateVideoState(enabled: boolean) {
    const videoProducer = this.producers.get('video');
    if (videoProducer) {
      if (enabled) {
        videoProducer.resume();
      } else {
        videoProducer.pause();
      }
    }
  }

  private cleanup(peerId: string) {
    const transport = this.consumerTransports.get(peerId);
    if (transport) {
      transport.close();
      this.consumerTransports.delete(peerId);
    }

    const consumer = this.consumers.get(peerId);
    if (consumer) {
      consumer.close();
      this.consumers.delete(peerId);
    }
  }

  public stopStreaming() {
    this.producers.forEach(producer => producer.close());
    this.producers.clear();
    if (this.producerTransport) {
      this.producerTransport.close();
      this.producerTransport = undefined;
    }
  }
}