import * as mediasoup from 'mediasoup';

export const config = {
  mediasoup: {
    worker: {
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
      logLevel: 'warn' as const,
    },
    router: {
      mediaCodecs: [
        {
          kind: 'video' as mediasoup.types.MediaKind,
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'audio' as mediasoup.types.MediaKind,
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
        },
      ],
    },
    webRtcServer: {
  listenInfos: [
    {
      protocol: 'udp' as const,
      ip: '0.0.0.0',
      announcedIp: undefined,
    },
    {
      protocol: 'tcp' as const,
      ip: '0.0.0.0',
      announcedIp: undefined,
    }
  ]
},
    webRtcTransport: {
      initialAvailableOutgoingBitrate: 1000000,
      minimumAvailableOutgoingBitrate: 600000,
      maxSctpMessageSize: 262144,
      enableSctp: true,
      numSctpStreams: { OS: 1024, MIS: 1024 }
    }
  },
  server: {
    port: process.env.PORT || 4000,
  }
}