"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { Device } from "mediasoup-client";
import {
  DtlsParameters,
  IceCandidate,
  IceParameters,
  Transport,
} from "mediasoup-client/lib/types";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const [params, setParams] = useState({
    encoding: [
      { rid: "r0", maxBitrate: 100000, scalabilityMode: "S1T3" },
      { rid: "r1", maxBitrate: 300000, scalabilityMode: "S1T3" },
      { rid: "r2", maxBitrate: 900000, scalabilityMode: "S1T3" },
    ],
    codecOptions: { videoGoogleStartBitrate: 1000 },
  });

  const [device, setDevice] = useState<Device | null>(null);
  const [socket, setSocket] = useState<any>(null);
  const [rtpCapabilities, setRtpCapabilities] = useState<any>(null);
  const [producerTransport, setProducerTransport] = useState<Transport | null>(null);
  const [consumerTransport, setConsumerTransport] = useState<any>(null);

  useEffect(() => {
    const socket = io("http://localhost:4000/mediasoup");

    setSocket(socket);
    socket.on("connection-success", (data) => {
      startCamera();
    });
    return () => {
      socket.disconnect();
    };
  }, []);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (videoRef.current) {
        const track = stream.getVideoTracks()[0];
        videoRef.current.srcObject = stream;
        setParams((current) => ({ ...current, track }));
      }
    } catch (error) {
      console.error("Error accessing camera:", error);
    }
  };

  const getRouterRtpCapabilities = async () => {
    socket.emit("getRouterRtpCapabilities", (data: any) => {
      setRtpCapabilities(data.routerRtpCapabilities);
      console.log(`getRouterRtpCapabilities: ${data.routerRtpCapabilities}`);
    });
  };

  const createDevice = async () => {
    try {
      const newDevice = new Device();
      await newDevice.load({ routerRtpCapabilities: rtpCapabilities });
      setDevice(newDevice);
    } catch (error: any) {
      console.log(error);
      if (error.name === "UnsupportedError") {
        console.error("Browser not supported");
      }
    }
  };


  const createRecvTransport = async () => {
    socket.emit(
      "createTransport",
      { sender: false },
      ({ params }: { params: any }) => {
        if (params.error) {
          console.log(params.error);
          return;
        }

        let transport = device?.createRecvTransport(params);
        setConsumerTransport(transport);

        transport?.on(
          "connect",
          async ({ dtlsParameters }: any, callback: any, errback: any) => {
            try {
              await socket.emit("connectConsumerTransport", { dtlsParameters });
              console.log("----------> consumer transport has connected");
              callback();
            } catch (error) {
              errback(error);
            }
          }
        );
      }
    );
  };

  const connectRecvTransport = async () => {
    await socket.emit(
      "consumeMedia",
      { rtpCapabilities: device?.rtpCapabilities },
      async ({ params }: any) => {
        if (params.error) {
          console.log(params.error);
          return;
        }

        let consumer = await consumerTransport.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
        });

        const { track } = consumer;
        console.log("************** track", track);

        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = new MediaStream([track]);
        }

        socket.emit("resumePausedConsumer", () => {});
        console.log("----------> consumer transport has resumed");
      }
    );
  };

  return (
    <main>
      <video ref={videoRef} id="localvideo" autoPlay playsInline />
      <video ref={remoteVideoRef} id="remotevideo" autoPlay playsInline />
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <button onClick={getRouterRtpCapabilities}>Get Router RTP Capabilities</button>
        <button onClick={createDevice}>Create Device</button>
        <button onClick={createRecvTransport}>Create recv transport</button>
        <button onClick={connectRecvTransport}>Connect recv transport and consume</button>
      </div>
    </main>
  );
}