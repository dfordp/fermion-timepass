"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { io } from "socket.io-client";
import { Device } from "mediasoup-client";
import {
  DtlsParameters,
  IceCandidate,
  IceParameters,
  Transport,
} from "mediasoup-client/lib/types";

export default function StreamPage() {
  const searchParams = useSearchParams();
  const roomId = searchParams.get('roomId') || '123';
  const username = searchParams.get('username') || 'streamer';
  const role = searchParams.get('role') || 'streamer';
  
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
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    const socket = io("http://localhost:4000/mediasoup");

    setSocket(socket);
    socket.on("connection-success", (data) => {
      console.log("Connected to server as streamer", data);
      // Join room as streamer
      socket.emit("join-room", { roomId, username, role });
      startCamera();
    });
    return () => {
      socket.disconnect();
    };
  }, [roomId, username, role]);

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

  const createSendTransport = async () => {
    socket.emit(
      "createTransport",
      { sender: true, roomId },
      ({
        params,
      }: {
        params: {
          id: string;
          iceParameters: IceParameters;
          iceCandidates: IceCandidate[];
          dtlsParameters: DtlsParameters;
          error?: unknown;
        };
      }) => {
        if (params.error) {
          console.log(params.error);
          return;
        }

        let transport = device?.createSendTransport(params);
        setProducerTransport(transport || null);

        transport?.on(
          "connect",
          async ({ dtlsParameters }: any, callback: any, errback: any) => {
            try {
              console.log("----------> producer transport has connected");
              socket.emit("connectProducerTransport", { dtlsParameters, roomId });
              callback();
            } catch (error) {
              errback(error);
            }
          }
        );

        transport?.on(
          "produce",
          async (parameters: any, callback: any, errback: any) => {
            const { kind, rtpParameters } = parameters;
            console.log("----------> transport-produce");
            try {
              socket.emit(
                "transport-produce",
                { kind, rtpParameters, roomId },
                ({ id }: any) => {
                  callback({ id });
                }
              );
            } catch (error) {
              errback(error);
            }
          }
        );
      }
    );
  };

  const connectSendTransport = async () => {
    let localProducer = await producerTransport?.produce(params);
    setIsStreaming(true);

    localProducer?.on("trackended", () => {
      console.log("trackended");
      setIsStreaming(false);
    });
    localProducer?.on("transportclose", () => {
      console.log("transportclose");
      setIsStreaming(false);
    });
  };

  return (
    <main className="p-8">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Streaming to Room: {roomId}</h1>
        <p>Connected as: {username} (Role: {role})</p>
        <p>Status: {isStreaming ? "Streaming" : "Not streaming"}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h2 className="text-xl mb-2">Local Preview</h2>
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            <video 
              ref={videoRef} 
              id="localvideo" 
              autoPlay 
              playsInline 
              className="w-full h-auto"
            />
          </div>
        </div>
        
        <div>
          <h2 className="text-xl mb-2">Remote View</h2>
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            <video 
              ref={remoteVideoRef} 
              id="remotevideo" 
              autoPlay 
              playsInline 
              className="w-full h-auto"
            />
          </div>
        </div>
      </div>
      
      <div className="mt-6 flex flex-wrap gap-3">
        <button 
          onClick={getRouterRtpCapabilities}
          className="bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-md"
        >
          1. Get Router RTP Capabilities
        </button>
        
        <button 
          onClick={createDevice}
          className="bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-md"
          disabled={!rtpCapabilities}
        >
          2. Create Device
        </button>
        
        <button 
          onClick={createSendTransport}
          className="bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-md"
          disabled={!device}
        >
          3. Create Send Transport
        </button>
        
        <button 
          onClick={connectSendTransport}
          className="bg-green-600 hover:bg-green-700 text-white py-2 px-4 rounded-md"
          disabled={!producerTransport}
        >
          4. Start Streaming
        </button>
        
        <button 
          onClick={() => window.history.back()}
          className="bg-gray-600 hover:bg-gray-700 text-white py-2 px-4 rounded-md ml-auto"
        >
          Back to Home
        </button>
      </div>
      
      <div className="mt-6 text-center text-sm text-gray-600 border-t pt-4">
        <p>Server running at: <span className="font-mono">https://localhost:3000</span></p>
      </div>
    </main>
  );
}