import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import * as mediasoup from "mediasoup"; 

const app = express();
const port = 4000;
const server = http.createServer(app);

app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);

const io = new Server(server, {
  cors: {
    origin: "*",
    credentials: true,
  },
});

const peers = io.of("/mediasoup");
let worker: mediasoup.types.Worker<mediasoup.types.AppData>;
let router: mediasoup.types.Router<mediasoup.types.AppData>;

let producerTransport:
  | mediasoup.types.WebRtcTransport<mediasoup.types.AppData>
  | undefined;
let consumerTransport:
  | mediasoup.types.WebRtcTransport<mediasoup.types.AppData>
  | undefined;

let producer: mediasoup.types.Producer<mediasoup.types.AppData> | undefined;
let consumer: mediasoup.types.Consumer<mediasoup.types.AppData> | undefined;

const createWorker = async (): Promise<
  mediasoup.types.Worker<mediasoup.types.AppData>
> => {
  const newWorker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });

  console.log(`Worker process ID ${newWorker.pid}`);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  newWorker.on("died", (error) => {
    console.error("mediasoup worker has died");
    setTimeout(() => {
      process.exit();
    }, 2000);
  });

  return newWorker;
};



const mediaCodecs: mediasoup.types.RtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 96,
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
    ],
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
    preferredPayloadType: 97,
    rtcpFeedback: [
      { type: "nack" },
      { type: "ccm", parameter: "fir" },
      { type: "goog-remb" },
    ],
  },
];

peers.on("connection", async (socket) => {
  console.log(`Peer connected: ${socket.id}`);
  socket.emit("connection-success", { socketId: socket.id });

  socket.on("disconnect", () => {
    console.log("Peer disconnected");
  });

  router = await worker.createRouter({
    mediaCodecs: mediaCodecs,
  });

  socket.on("getRouterRtpCapabilities", (callback) => {
    const routerRtpCapabilities = router.rtpCapabilities;
    callback({ routerRtpCapabilities });
  });

  socket.on("createTransport", async ({ sender }, callback) => {
    if (sender) {
      producerTransport = await createWebRtcTransport(callback);
    } else {
      consumerTransport = await createWebRtcTransport(callback);
    }
  });

  socket.on("connectProducerTransport", async ({ dtlsParameters }) => {
    await producerTransport?.connect({ dtlsParameters });
  });

  socket.on("transport-produce", async ({ kind, rtpParameters }, callback) => {
    producer = await producerTransport?.produce({
      kind,
      rtpParameters,
    });

    producer?.on("transportclose", () => {
      console.log("Producer transport closed");
      producer?.close();
    });

    callback({ id: producer?.id });
  });

  socket.on("connectConsumerTransport", async ({ dtlsParameters }) => {
    await consumerTransport?.connect({ dtlsParameters });
  });

  socket.on("consumeMedia", async ({ rtpCapabilities }, callback) => {
    try {
      if (producer) {
        if (!router.canConsume({ producerId: producer?.id, rtpCapabilities })) {
          console.error("Cannot consume");
          return;
        }
        console.log("-------> consume");

        consumer = await consumerTransport?.consume({
          producerId: producer?.id,
          rtpCapabilities,
          paused: producer?.kind === "video",
        });

        consumer?.on("transportclose", () => {
          console.log("Consumer transport closed");
          consumer?.close();
        });

        consumer?.on("producerclose", () => {
          console.log("Producer closed");
          consumer?.close();
        });

        callback({
          params: {
            producerId: producer?.id,
            id: consumer?.id,
            kind: consumer?.kind,
            rtpParameters: consumer?.rtpParameters,
          },
        });
      }
    } catch (error) {
      console.error("Error consuming:", error);
      callback({
        params: {
          error,
        },
      });
    }
  });

  socket.on("resumePausedConsumer", async () => {
    console.log("consume-resume");
    await consumer?.resume();
  });
});

const createWebRtcTransport = async (
  callback: (arg0: {
    params:
      | {
          id: string;
          iceParameters: mediasoup.types.IceParameters;
          iceCandidates: mediasoup.types.IceCandidate[];
          dtlsParameters: mediasoup.types.DtlsParameters;
        }
      | {
          error: unknown;
        };
  }) => void
) => {
  try {
    const webRtcTransportOptions = {
      listenIps: [
        {
          ip: "127.0.0.1",
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    };

    const transport = await router.createWebRtcTransport(webRtcTransportOptions);

    console.log(`Transport created: ${transport.id}`);

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    transport.on("@close", () => {
      console.log("Transport closed");
    });

    callback({
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    });

    return transport;
  } catch (error) {
    console.log(error);
    callback({
      params: {
        error,
      },
    });
  }
};

async function initializeServer() {
  try {
    worker = await createWorker();
    
    server.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Failed to initialize server:', error);
    process.exit(1);
  }
}

// Call the initialization function
initializeServer();