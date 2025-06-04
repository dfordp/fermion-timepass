"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { io } from "socket.io-client";
import Hls from "hls.js";

export default function WatchPage() {
  const searchParams = useSearchParams();
  const roomId = searchParams.get('roomId') || '123';
  const username = searchParams.get('username') || 'viewer';
  const role = searchParams.get('role') || 'watcher';
  
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [socket, setSocket] = useState<any>(null);
  const [connected, setConnected] = useState(false);
  const [hlsUrl, setHlsUrl] = useState<string | null>(null);
  const [streamActive, setStreamActive] = useState(false);
  const [hls, setHls] = useState<Hls | null>(null);

  useEffect(() => {
    // Connect to the socket server
    const socket = io("http://localhost:4000/mediasoup");

    setSocket(socket);
    socket.on("connection-success", (data: any) => {
      console.log("Connected to server as watcher", data);
      setConnected(true);
      
      // Join room as watcher
      socket.emit("join-room", { roomId, username, role });
      
      // Request HLS stream information
      socket.emit("get-hls-url", { roomId }, (response: any) => {
        if (response.url) {
          setHlsUrl(response.url);
          setStreamActive(response.active || false);
        }
      });
    });
    
    // Listen for stream status updates
    socket.on("hls-stream-status", (data: any) => {
      if (data.roomId === roomId) {
        setStreamActive(data.active);
        if (data.active && data.url) {
          setHlsUrl(data.url);
          initHlsPlayer(data.url);
        } else {
          // Stream is no longer active
          destroyHlsPlayer();
        }
      }
    });
    
    return () => {
      destroyHlsPlayer();
      socket.disconnect();
    };
  }, [roomId, username, role]);

  // Initialize or update HLS player when URL changes
  useEffect(() => {
    if (hlsUrl && streamActive) {
      initHlsPlayer(hlsUrl);
    }
    
    return () => {
      destroyHlsPlayer();
    };
  }, [hlsUrl, streamActive]);

  const initHlsPlayer = (url: string) => {
    if (!videoRef.current) return;
    
    // Clean up existing player if any
    destroyHlsPlayer();
    
    const fullUrl = url.startsWith('http') ? url : `http://localhost:3000${url}`;
    
    if (Hls.isSupported()) {
      const newHls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
        // Debug settings - remove in production
        debug: false,
      });
      
      newHls.loadSource(fullUrl);
      newHls.attachMedia(videoRef.current);
      
      newHls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log("HLS manifest parsed, attempting to play");
        videoRef.current?.play().catch(err => {
          console.error("Error playing HLS stream:", err);
        });
      });
      
      newHls.on(Hls.Events.ERROR, (event, data) => {
        console.log("HLS error:", data);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              // Try to recover network error
              console.log("Fatal network error, trying to recover");
              newHls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log("Fatal media error, trying to recover");
              newHls.recoverMediaError();
              break;
            default:
              // Cannot recover
              console.log("Fatal error, cannot recover");
              destroyHlsPlayer();
              break;
          }
        }
      });
      
      setHls(newHls);
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      // For Safari
      videoRef.current.src = fullUrl;
      videoRef.current.play().catch(err => {
        console.error("Error playing HLS stream in Safari:", err);
      });
    } else {
      console.error("HLS is not supported on this browser");
    }
  };

  const destroyHlsPlayer = () => {
    if (hls) {
      hls.destroy();
      setHls(null);
    }
    
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
  };

  return (
    <main className="p-8">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Watching Room: {roomId}</h1>
        <p>Connected as: {username} (Role: {role})</p>
        <p>Status: {connected ? (streamActive ? "Stream Active" : "Waiting for Stream") : "Connecting..."}</p>
      </div>
      
      <div className="bg-gray-800 rounded-lg overflow-hidden max-w-4xl mx-auto">
        {streamActive ? (
          <video 
            ref={videoRef}
            controls
            playsInline
            className="w-full h-auto"
          />
        ) : (
          <div className="bg-gray-200 aspect-video flex items-center justify-center">
            <p className="text-gray-600 text-lg">Waiting for stream to begin...</p>
          </div>
        )}
      </div>
      
      <div className="mt-6 flex justify-between">
        <button 
          onClick={() => window.history.back()}
          className="bg-gray-600 hover:bg-gray-700 text-white py-2 px-4 rounded-md"
        >
          Back to Home
        </button>
        
        {hlsUrl && (
          <button 
            onClick={() => initHlsPlayer(hlsUrl)}
            className="bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-md"
          >
            Reload Stream
          </button>
        )}
      </div>
      
      {hlsUrl && (
        <div className="mt-4 p-4 bg-gray-100 rounded-md text-sm">
          <p>Stream URL: {hlsUrl}</p>
        </div>
      )}
    </main>
  );
}