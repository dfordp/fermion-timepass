import * as mediasoup from 'mediasoup';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { MediaRecorder } from './recorder';

export class HlsManager {
  private hlsOutputPath: string;
  private app: express.Application;
  private recorders: Map<string, MediaRecorder> = new Map();
  private _activeRooms: Map<
    string,
    {
      ffmpegProcess: ChildProcess | null;
      plainTransports: mediasoup.types.PlainTransport[];
      outputPath: string;
    }
  > = new Map();

  constructor(
    app: express.Application,
    outputPath: string = path.join(__dirname, '../..', 'public', 'hls')
  ) {
    this.app = app;
    this.hlsOutputPath = outputPath;

    if (!fs.existsSync(this.hlsOutputPath)) {
      fs.mkdirSync(this.hlsOutputPath, { recursive: true });
    }

    this.app.use('/hls', express.static(this.hlsOutputPath));
    console.log(`HLS manager initialized—serving from ${this.hlsOutputPath}`);
  }

  public isStreamActive(roomId: string): boolean {
    return this._activeRooms.has(roomId);
  }

  /** 
   * Creates or updates a stream for a room using the actual WebRTC video
   */
  public async updateRoomStream(
    roomId: string,
    router: mediasoup.types.Router,
    producers: any[] | any
  ): Promise<string> {
    console.log(`Received ${producers?.length || 0} producers for room ${roomId}`);
    
    // Check if producers is empty
    if (!producers || (Array.isArray(producers) && producers.length === 0)) {
      console.log(`No producers available, cannot create WebRTC stream`);
      return await this.testHlsGeneration(roomId);
    }
  
    // Ensure producers is an array
    const producersArray = Array.isArray(producers) ? producers : [producers];
    console.log(`Received ${producersArray.length} producers for room ${roomId}`);
  
    try {
      // Get the actual producer objects from the router using the producer ids
      const realProducers: mediasoup.types.Producer[] = [];
      
      for (const producer of producersArray) {
        // If we already have a real producer object with kind property
        if (producer && typeof producer.kind === 'string') {
          console.log(`Found real producer: ${producer.id}, kind: ${producer.kind}`);
          realProducers.push(producer);
        } 
        // If we have a producer ID or an object with an ID
        else if (producer && (typeof producer === 'string' || producer.id)) {
          const producerId = typeof producer === 'string' ? producer : producer.id;
          try {
            // Try to get the producer from the router
            const actualProducer = router.getProducerById(producerId);
            if (actualProducer) {
              console.log(`Got producer from router: ${actualProducer.id}, kind: ${actualProducer.kind}`);
              realProducers.push(actualProducer);
            }
          } catch (error) {
            console.error(`Error getting producer ${producerId} from router:`, error.message);
          }
        }
      }
  
      console.log(`Found ${realProducers.length} real producers for room ${roomId}`);
  
      // Filter to only active producers
      const activeProducers = realProducers.filter(p => !p.closed && !p.paused);
      console.log(`Using ${activeProducers.length} active producers for WebRTC stream`);
  
      if (activeProducers.length === 0) {
        console.log(`No active producers available`);
        return await this.testHlsGeneration(roomId);
      }
  
      // Try to create the WebRTC stream
      const result = await this.createRoomHlsStream(roomId, router, activeProducers);
      return result;
    } catch (error) {
      console.error(`Error creating WebRTC stream: ${error.message}`);
      return await this.testHlsGeneration(roomId);
    }
  }

  /**
   * Creates an HLS stream from WebRTC producers
   */
  public async createRoomHlsStream(
    roomId: string,
    router: mediasoup.types.Router,
    producers: mediasoup.types.Producer[]
  ): Promise<string> {
    // Stop any existing stream
    await this.stopRoomHlsStream(roomId);
    
    const roomOutputPath = path.join(this.hlsOutputPath, roomId);
    if (!fs.existsSync(roomOutputPath)) {
      fs.mkdirSync(roomOutputPath, { recursive: true });
    }
    
    // Separate video and audio producers
    const videoProducers = producers.filter(p => p.kind === 'video');
    const audioProducers = producers.filter(p => p.kind === 'audio');
    
    console.log(`Room ${roomId} has ${videoProducers.length} video and ${audioProducers.length} audio producers`);
    
    if (videoProducers.length === 0) {
      return this.testHlsGeneration(roomId);
    }
    
    try {
      // Create a new recorder for this room
      const recorder = new MediaRecorder(this.hlsOutputPath);
      this.recorders.set(roomId, recorder);
      
      // Start recording with the first video and audio producer
      const hlsUrl = await recorder.startRecording(
        roomId,
        router,
        videoProducers[0],
        audioProducers.length > 0 ? audioProducers[0] : null
      );
      
      // Store in active rooms
      this._activeRooms.set(roomId, {
        ffmpegProcess: null, // The recorder manages the process now
        plainTransports: [], // The recorder manages the transports now
        outputPath: roomOutputPath,
      });
      
      return hlsUrl;
    } catch (error) {
      console.error(`Error starting recording: ${error.message}`);
      return this.testHlsGeneration(roomId);
    }
  }

  public async stopRoomHlsStream(roomId: string): Promise<void> {
    const state = this._activeRooms.get(roomId);
    if (!state) return;

    // Stop the recorder if it exists
    if (this.recorders.has(roomId)) {
      this.recorders.get(roomId)?.stopRecording();
      this.recorders.delete(roomId);
    }
    
    if (state.ffmpegProcess) {
      try {
        state.ffmpegProcess.kill('SIGINT');
      } catch (err) {
        console.error(`Error stopping FFmpeg process: ${err.message}`);
      }
    }
    
    for (const t of state.plainTransports) {
      try {
        t.close();
      } catch (err) {
        console.error(`Error closing transport: ${err.message}`);
      }
    }
    
    this._activeRooms.delete(roomId);
    console.log(`Stopped HLS for room ${roomId}`);
  }

  public getHlsUrl(roomId: string): string {
    return `/hls/${roomId}/playlist.m3u8`;
  }

  /**
   * Generate an HLS stream with a test pattern
   * Used as fallback if WebRTC streaming fails
   */
  public async testHlsGeneration(roomId: string): Promise<string> {
    console.log(`WARNING: Using test pattern generation - NOT real video`);
    
    // Stop any existing stream
    await this.stopRoomHlsStream(roomId);
    
    const roomOutputPath = path.join(this.hlsOutputPath, roomId);
    if (!fs.existsSync(roomOutputPath)) {
      fs.mkdirSync(roomOutputPath, { recursive: true });
    }
    
    console.log(`Running test HLS generation for room ${roomId}`);
    
    // Generate a simple solid color instead of test pattern
    const ffmpegProcess = spawn('ffmpeg', [
      '-f', 'lavfi',
      '-i', 'color=c=blue:s=1280x720:r=30:d=3600',
      '-f', 'lavfi', 
      '-i', 'anullsrc=r=44100:cl=stereo',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-g', '48',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+append_list+omit_endlist',
      '-hls_segment_filename', path.join(roomOutputPath, 'segment_%03d.ts'),
      path.join(roomOutputPath, 'playlist.m3u8'),
    ]);
    
    // Store in active rooms
    this._activeRooms.set(roomId, {
      ffmpegProcess,
      plainTransports: [],
      outputPath: roomOutputPath,
    });
    
    return `/hls/${roomId}/playlist.m3u8`;
  }
}