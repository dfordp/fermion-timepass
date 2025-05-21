'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './steam.module.css'
import { WebRTCService } from '@/lib/webrtc'

interface StreamState {
  isStreaming: boolean;
  isMicOn: boolean;
  isCameraOn: boolean;
  error: string | null;
}

export default function StreamPage() {
  const [state, setState] = useState<StreamState>({
    isStreaming: false,
    isMicOn: false,
    isCameraOn: false,
    error: null
  })
  const [peers, setPeers] = useState<string[]>([])
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const webrtcServiceRef = useRef<WebRTCService>(null)
  const streamRef = useRef<MediaStream>(null)

  useEffect(() => {
    try {
      webrtcServiceRef.current = new WebRTCService()
      
      webrtcServiceRef.current.onPeerJoined((peerId) => {
        setPeers(prev => [...prev, peerId])
      })

      webrtcServiceRef.current.onPeerLeft((peerId) => {
        setPeers(prev => prev.filter(id => id !== peerId))
      })

      webrtcServiceRef.current.onRemoteStream((stream) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = stream
        }
      })

      webrtcServiceRef.current.onError((error) => {
        setState(prev => ({ ...prev, error: error.message }))
        console.error('WebRTC error:', error)
      })

      return () => {
        stopStream()
        webrtcServiceRef.current?.disconnect()
      }
    } catch (error) {
      console.error('Failed to initialize WebRTC service:', error)
      setState(prev => ({ ...prev, error: 'Failed to initialize video chat' }))
    }
  }, [])

  const startStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      })

      streamRef.current = stream

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
        setState(prev => ({
          ...prev,
          isStreaming: true,
          isMicOn: true,
          isCameraOn: true,
          error: null
        }))

        await webrtcServiceRef.current?.startStreaming(stream)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to access media devices'
      console.error('Media error:', error)
      setState(prev => ({ ...prev, error: errorMessage }))
    }
  }

  const toggleMic = () => {
    try {
      if (streamRef.current) {
        const audioTracks = streamRef.current.getAudioTracks()
        const newState = !state.isMicOn
        
        audioTracks.forEach(track => {
          track.enabled = newState
        })
        
        setState(prev => ({ ...prev, isMicOn: newState }))
        webrtcServiceRef.current?.updateAudioState(newState)
      }
    } catch (error) {
      console.error('Failed to toggle microphone:', error)
      setState(prev => ({ ...prev, error: 'Failed to toggle microphone' }))
    }
  }

  const toggleCamera = () => {
    try {
      if (streamRef.current) {
        const videoTracks = streamRef.current.getVideoTracks()
        const newState = !state.isCameraOn
        
        videoTracks.forEach(track => {
          track.enabled = newState
        })
        
        setState(prev => ({ ...prev, isCameraOn: newState }))
        webrtcServiceRef.current?.updateVideoState(newState)
      }
    } catch (error) {
      console.error('Failed to toggle camera:', error)
      setState(prev => ({ ...prev, error: 'Failed to toggle camera' }))
    }
  }

  const stopStream = () => {
    try {
      if (streamRef.current) {
        const tracks = streamRef.current.getTracks()
        tracks.forEach(track => track.stop())
        streamRef.current = undefined
        
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = null
        }
        
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = null
        }

        setState(prev => ({
          ...prev,
          isStreaming: false,
          isMicOn: false,
          isCameraOn: false,
          error: null
        }))
        
        webrtcServiceRef.current?.stopStreaming()
      }
    } catch (error) {
      console.error('Failed to stop stream:', error)
      setState(prev => ({ ...prev, error: 'Failed to stop stream' }))
    }
  }

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
        <div className={styles.videoContainer}>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className={styles.video}
          />
          {peers.length > 0 && (
            <div className={styles.peerInfo}>
              Connected Peers: {peers.length}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}