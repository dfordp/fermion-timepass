"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { io } from "socket.io-client";
import { Device } from "mediasoup-client";

export default function WatchPage() {
  const searchParams = useSearchParams();
  const roomId = searchParams.get('roomId') || '123';
  const username = searchParams.get('username') || 'viewer';
  const role = searchParams.get('role') || 'watcher';
  
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const [socket, setSocket] = useState<any>(null);
  const [connected, setConnected] = useState(false);
  const [streams, setStreams] = useState<any[]>([]);

  useEffect(() => {
    const socket = io("http://localhost:4000/mediasoup");

    setSocket(socket);
    socket.on("connection-success", (data: any) => {
      console.log("Connected to server as watcher", data);
      setConnected(true);
      
      // Join room as watcher
      socket.emit("join-room", { roomId, username, role });
    });
    
    socket.on("new-producer", (data: any) => {
      console.log("New producer available", data);
      // Here you would set up a consumer to receive the stream
    });
    
    return () => {
      socket.disconnect();
    };
  }, [roomId, username, role]);

  return (
    <main className="p-8">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Watching Room: {roomId}</h1>
        <p>Connected as: {username} (Role: {role})</p>
        <p>Status: {connected ? "Connected to server" : "Connecting..."}</p>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {streams.length === 0 ? (
          <div className="bg-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-600">Waiting for streams...</p>
          </div>
        ) : (
          streams.map((stream, index) => (
            <div key={index} className="bg-gray-800 rounded-lg overflow-hidden">
              <video 
                ref={index === 0 ? remoteVideoRef : null}
                autoPlay 
                playsInline 
                className="w-full h-auto"
              />
              <div className="p-2 bg-black text-white">
                <p>{stream.username || "Unknown streamer"}</p>
              </div>
            </div>
          ))
        )}
      </div>
      
      <div className="mt-6">
        <button 
          onClick={() => window.history.back()}
          className="bg-gray-600 hover:bg-gray-700 text-white py-2 px-4 rounded-md"
        >
          Back to Home
        </button>
      </div>
    </main>
  );
}