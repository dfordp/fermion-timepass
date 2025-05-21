'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './steam.module.css'
import { WebRTCService } from '@/lib/webrtc'

interface StreamState {
  isStreaming: boolean;
  isMicOn: boolean;
  isCameraOn: boolean;
  error: string | null;
  streams: Map<string, MediaStream>;
}

export default function StreamPage() {
  const [state, setState] = useState<StreamState>({
    isStreaming: false,
    isMicOn: false,
    isCameraOn: false,
    error: null,
    streams: new Map()
  });
  
  const [peers, setPeers] = useState<string[]>([]);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideosRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const webrtcServiceRef = useRef<WebRTCService | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    try {
      webrtcServiceRef.current = new WebRTCService("streamer");
      
      webrtcServiceRef.current.onPeerJoined((peerId) => {
        setPeers(prev => [...prev, peerId]);
      });

      webrtcServiceRef.current.onPeerLeft((peerId) => {
        setPeers(prev => prev.filter(id => id !== peerId));
        setState(prev => {
          const newStreams = new Map(prev.streams);
          newStreams.delete(peerId);
          return { ...prev, streams: newStreams };
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
          
          return { ...prev, streams: newStreams };
        });
      });

      webrtcServiceRef.current.onError((error) => {
        setState(prev => ({ ...prev, error: error.message }));
        console.error('WebRTC error:', error);
      });

      return () => {
        stopStream();
        webrtcServiceRef.current?.disconnect();
      };
    } catch (error) {
      console.error('Failed to initialize WebRTC service:', error);
      setState(prev => ({ ...prev, error: 'Failed to initialize video chat' }));
    }
  }, []);

  const startStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

      streamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        setState(prev => ({
          ...prev,
          isStreaming: true,
          isMicOn: true,
          isCameraOn: true,
          error: null
        }));

        await webrtcServiceRef.current?.startStreaming(stream);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to access media devices';
      console.error('Media error:', error);
      setState(prev => ({ ...prev, error: errorMessage }));
    }
  };

  const toggleMic = () => {
    try {
      if (streamRef.current) {
        const audioTracks = streamRef.current.getAudioTracks();
        const newState = !state.isMicOn;
        
        audioTracks.forEach(track => {
          track.enabled = newState;
        });
        
        setState(prev => ({ ...prev, isMicOn: newState }));
        webrtcServiceRef.current?.updateAudioState(newState);
      }
    } catch (error) {
      console.error('Failed to toggle microphone:', error);
      setState(prev => ({ ...prev, error: 'Failed to toggle microphone' }));
    }
  };

  const toggleCamera = () => {
    try {
      if (streamRef.current) {
        const videoTracks = streamRef.current.getVideoTracks();
        const newState = !state.isCameraOn;
        
        videoTracks.forEach(track => {
          track.enabled = newState;
        });
        
        setState(prev => ({ ...prev, isCameraOn: newState }));
        webrtcServiceRef.current?.updateVideoState(newState);
      }
    } catch (error) {
      console.error('Failed to toggle camera:', error);
      setState(prev => ({ ...prev, error: 'Failed to toggle camera' }));
    }
  };

  const stopStream = () => {
    try {
      if (streamRef.current) {
        const tracks = streamRef.current.getTracks();
        tracks.forEach(track => track.stop());
        streamRef.current = null;
        
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = null;
        }

        setState(prev => {
          const newState = {
            ...prev,
            isStreaming: false,
            isMicOn: false,
            isCameraOn: false,
            error: null,
            streams: new Map()
          };
          return newState;
        });
        
        webrtcServiceRef.current?.stopStreaming();
      }
    } catch (error) {
      console.error('Failed to stop stream:', error);
      setState(prev => ({ ...prev, error: 'Failed to stop stream' }));
    }
  };

  return (
    <div className={styles.container}>
      {state.error && (
        <div className={styles.error}>
          {state.error}
        </div>
      )}
      <div className={styles.videoGrid}>
        <div className={styles.videoContainer}>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className={styles.video}
          />
          <div className={styles.controls}>
            {!state.isStreaming ? (
              <button 
                onClick={startStream}
                disabled={!!state.error}
              >
                Start Stream
              </button>
            ) : (
              <>
                <button 
                  onClick={toggleMic}
                  disabled={!!state.error}
                >
                  {state.isMicOn ? 'Mute' : 'Unmute'}
                </button>
                <button 
                  onClick={toggleCamera}
                  disabled={!!state.error}
                >
                  {state.isCameraOn ? 'Stop Camera' : 'Start Camera'}
                </button>
                <button onClick={stopStream}>
                  End Stream
                </button>
              </>
            )}
          </div>
        </div>
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
              Peer: {peerId}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}