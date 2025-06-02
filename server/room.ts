import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';
import config from './config';
import Peer from './peer';

export default class Room {
  id: string;
  router!: mediasoup.types.Router;
  peers: Map<string, Peer>;
  io: Server;

  constructor(room_id: string, worker: mediasoup.types.Worker, io: Server) {
    this.id = room_id;
    const mediaCodecs = config.mediasoup.router.mediaCodecs;
    worker
      .createRouter({
        mediaCodecs
      })
      .then((router) => {
        this.router = router;
      });

    this.peers = new Map();
    this.io = io;
  }

  addPeer(peer: Peer): void {
    this.peers.set(peer.id, peer);
  }

  getProducerListForPeer(): { producer_id: string }[] {
    const producerList: { producer_id: string }[] = [];
    this.peers.forEach((peer) => {
      peer.producers.forEach((producer) => {
        producerList.push({
          producer_id: producer.id
        });
      });
    });
    return producerList;
  }

  getRtpCapabilities(): mediasoup.types.RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  async createWebRtcTransport(socket_id: string): Promise<{
    params: {
      id: string;
      iceParameters: mediasoup.types.IceParameters;
      iceCandidates: mediasoup.types.IceCandidate[];
      dtlsParameters: mediasoup.types.DtlsParameters;
    }
  }> {
    const { maxIncomingBitrate, initialAvailableOutgoingBitrate } = config.mediasoup.webRtcTransport;

    const transport = await this.router.createWebRtcTransport({
      listenIps: config.mediasoup.webRtcTransport.listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate
    });
    
    if (maxIncomingBitrate) {
      try {
        await transport.setMaxIncomingBitrate(maxIncomingBitrate);
      } catch (error) {}
    }

    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') {
        console.log('Transport close', { name: this.peers.get(socket_id)?.name });
        transport.close();
      }
    });

    transport.on('close', () => {
      console.log('Transport close', { name: this.peers.get(socket_id)?.name });
    });

    console.log('Adding transport', { transportId: transport.id });
    this.peers.get(socket_id)?.addTransport(transport);
    
    return {
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      }
    };
  }

  async connectPeerTransport(socket_id: string, transport_id: string, dtlsParameters: mediasoup.types.DtlsParameters): Promise<void> {
    if (!this.peers.has(socket_id)) return;

    await this.peers.get(socket_id)!.connectTransport(transport_id, dtlsParameters);
  }

  async produce(socket_id: string, producerTransportId: string, rtpParameters: mediasoup.types.RtpParameters, kind: mediasoup.types.MediaKind): Promise<string> {
    return new Promise(async (resolve) => {
      const peer = this.peers.get(socket_id);
      if (!peer) throw new Error('Peer not found');
      
      const producer = await peer.createProducer(producerTransportId, rtpParameters, kind);
      resolve(producer.id);
      
      this.broadCast(socket_id, 'newProducers', [
        {
          producer_id: producer.id,
          producer_socket_id: socket_id
        }
      ]);
    });
  }

  async consume(
    socket_id: string, 
    consumer_transport_id: string, 
    producer_id: string, 
    rtpCapabilities: mediasoup.types.RtpCapabilities
  ): Promise<any> {
    if (!this.router.canConsume({
      producerId: producer_id,
      rtpCapabilities
    })) {
      console.error('can not consume');
      return;
    }

    const peer = this.peers.get(socket_id);
    if (!peer) return;

    const consumerResult = await peer.createConsumer(consumer_transport_id, producer_id, rtpCapabilities);
    if (!consumerResult) return;
    
    const { consumer, params } = consumerResult;

    consumer.on('producerclose', () => {
      console.log('Consumer closed due to producerclose event', {
        name: `${peer.name}`,
        consumer_id: `${consumer.id}`
      });
      peer.removeConsumer(consumer.id);
      // tell client consumer is dead
      this.io.to(socket_id).emit('consumerClosed', {
        consumer_id: consumer.id
      });
    });

    return params;
  }

  async removePeer(socket_id: string): Promise<void> {
    const peer = this.peers.get(socket_id);
    if (peer) {
      peer.close();
      this.peers.delete(socket_id);
    }
  }

  closeProducer(socket_id: string, producer_id: string): void {
    const peer = this.peers.get(socket_id);
    if (peer) {
      peer.closeProducer(producer_id);
    }
  }

  broadCast(socket_id: string, name: string, data: any): void {
    for (let otherID of Array.from(this.peers.keys()).filter((id) => id !== socket_id)) {
      this.send(otherID, name, data);
    }
  }

  send(socket_id: string, name: string, data: any): void {
    this.io.to(socket_id).emit(name, data);
  }

  getPeers(): Map<string, Peer> {
    return this.peers;
  }

  toJson(): { id: string; peers: string } {
    return {
      id: this.id,
      peers: JSON.stringify(Array.from(this.peers.entries()))
    };
  }
}