'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './watch.module.css'
import { WebRTCService } from '@/lib/webrtc'

interface WatchState {
  isConnected: boolean;
  error: string | null;
  streams: Map<string, MediaStream>;
}

export default function WatchPage() {
  const [state, setState] = useState<WatchState>({
    isConnected: false,
    error: null,
    streams: new Map()
  });
  const [peers, setPeers] = useState<string[]>([]);
  const remoteVideosRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const webrtcServiceRef = useRef<WebRTCService>(null);

  useEffect(() => {
    try {
      webrtcServiceRef.current = new WebRTCService("viewer");
      
      webrtcServiceRef.current.onPeerJoined((peerId) => {
        setPeers(prev => [...prev, peerId]);
      });

      webrtcServiceRef.current.onPeerLeft((peerId) => {
        setPeers(prev => prev.filter(id => id !== peerId));
        setState(prev => {
          const newStreams = new Map(prev.streams);
          newStreams.delete(peerId);
          return { 
            ...prev, 
            streams: newStreams,
            isConnected: newStreams.size > 0 
          };
        });
      });

      webrtcServiceRef.current.onRemoteStream((stream, peerId, kind) => {
        setState(prev => {
          const newStreams = new Map(prev.streams);
          if (!newStreams.has(peerId)) {
            newStreams.set(peerId, new MediaStream());
          }
          const existingStream = newStreams.get(peerId)!;
          
          existingStream.getTracks()
            .filter(track => track.kind === kind)
            .forEach(track => existingStream.removeTrack(track));
          
          stream.getTracks().forEach(track => existingStream.addTrack(track));
          
          return { 
            ...prev, 
            streams: newStreams,
            isConnected: true 
          };
        });
      });

      webrtcServiceRef.current.onError((error) => {
        setState(prev => ({ ...prev, error: error.message }));
        console.error('WebRTC error:', error);
      });

      return () => {
        webrtcServiceRef.current?.disconnect();
      };
    } catch (error) {
      console.error('Failed to initialize WebRTC service:', error);
      setState(prev => ({ ...prev, error: 'Failed to initialize video chat' }));
    }
  }, []);

  return (
    <div className={styles.container}>
      {state.error && (
        <div className={styles.error}>
          {state.error}
        </div>
      )}
      <div className={styles.videoGrid}>
        {Array.from(state.streams.entries()).map(([peerId, stream]) => (
          <div key={peerId} className={styles.videoContainer}>
            <video
              ref={el => {
                if (el) {
                  remoteVideosRef.current.set(peerId, el);
                  el.srcObject = stream;
                }
              }}
              autoPlay
              playsInline
              className={styles.video}
            />
            <div className={styles.peerInfo}>
              Streamer: {peerId}
            </div>
          </div>
        ))}
        {state.streams.size === 0 && (
          <div className={styles.noStreams}>
            {peers.length > 0 ? 'Connecting to streamers...' : 'Waiting for streamers...'}
          </div>
        )}
      </div>
    </div>
  );
}