import * as mediasoup from 'mediasoup';

export default class Peer {
  id: string;
  name: string;
  transports: Map<string, mediasoup.types.WebRtcTransport>;
  consumers: Map<string, mediasoup.types.Consumer>;
  producers: Map<string, mediasoup.types.Producer>;

  constructor(socket_id: string, name: string) {
    this.id = socket_id;
    this.name = name;
    this.transports = new Map();
    this.consumers = new Map();
    this.producers = new Map();
  }

  addTransport(transport: mediasoup.types.WebRtcTransport): void {
    this.transports.set(transport.id, transport);
  }

  async connectTransport(transport_id: string, dtlsParameters: mediasoup.types.DtlsParameters): Promise<void> {
    if (!this.transports.has(transport_id)) return;

    await this.transports.get(transport_id)!.connect({
      dtlsParameters: dtlsParameters
    });
  }

  async createProducer(
    producerTransportId: string, 
    rtpParameters: mediasoup.types.RtpParameters, 
    kind: mediasoup.types.MediaKind
  ): Promise<mediasoup.types.Producer> {
    const producer = await this.transports.get(producerTransportId)!.produce({
      kind,
      rtpParameters
    });

    this.producers.set(producer.id, producer);

    producer.on('transportclose', () => {
      console.log('Producer transport close', { name: `${this.name}`, producer_id: `${producer.id}` });
      producer.close();
      this.producers.delete(producer.id);
    });

    return producer;
  }

  async createConsumer(
    consumer_transport_id: string, 
    producer_id: string, 
    rtpCapabilities: mediasoup.types.RtpCapabilities
  ): Promise<{
    consumer: mediasoup.types.Consumer,
    params: {
      producerId: string,
      id: string,
      kind: mediasoup.types.MediaKind,
      rtpParameters: mediasoup.types.RtpParameters,
      type: mediasoup.types.ConsumerType,
      producerPaused: boolean
    }
  } | undefined> {
    const consumerTransport = this.transports.get(consumer_transport_id);
    if (!consumerTransport) return;

    let consumer: mediasoup.types.Consumer;
    try {
      consumer = await consumerTransport.consume({
        producerId: producer_id,
        rtpCapabilities,
        paused: false
      });
    } catch (error) {
      console.error('Consume failed', error);
      return;
    }

    if (consumer.type === 'simulcast') {
      await consumer.setPreferredLayers({
        spatialLayer: 2,
        temporalLayer: 2
      });
    }

    this.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
      console.log('Consumer transport close', { name: `${this.name}`, consumer_id: `${consumer.id}` });
      this.consumers.delete(consumer.id);
    });

    return {
      consumer,
      params: {
        producerId: producer_id,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused
      }
    };
  }

  closeProducer(producer_id: string): void {
    try {
      this.producers.get(producer_id)?.close();
    } catch (e) {
      console.warn(e);
    }

    this.producers.delete(producer_id);
  }

  getProducer(producer_id: string): mediasoup.types.Producer | undefined {
    return this.producers.get(producer_id);
  }

  close(): void {
    this.transports.forEach((transport) => transport.close());
  }

  removeConsumer(consumer_id: string): void {
    this.consumers.delete(consumer_id);
  }
}