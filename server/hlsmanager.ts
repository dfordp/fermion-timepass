import * as mediasoup from 'mediasoup';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import express from 'express';

export class HlsManager {
  private hlsOutputPath: string;
  private app: express.Application;
  private _activeRooms: Map<
    string,
    {
      ffmpegProcess: ChildProcess | null;
      plainTransports: mediasoup.types.PlainTransport[];
      outputPath: string;
    }
  > = new Map();
  private usedPorts: Set<number> = new Set();
  private ffmpegLogLevel: 'quiet' | 'panic' | 'fatal' | 'error' | 'warning' | 'info' | 'verbose' | 'debug' | 'trace';

  constructor(
    app: express.Application,
    outputPath: string = path.join(__dirname, '../..', 'public', 'hls'),
    ffmpegLogLevel: 'quiet' | 'panic' | 'fatal' | 'error' | 'warning' | 'info' | 'verbose' | 'debug' | 'trace' = 'warning'
  ) {
    this.app = app;
    this.hlsOutputPath = outputPath;
    this.ffmpegLogLevel = ffmpegLogLevel;

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
   * Creates a new HLS stream for a room
   */
  public async createRoomHlsStream(
    roomId: string, 
    router: mediasoup.types.Router, 
    producers: Map<string, mediasoup.types.Producer>
  ): Promise<string> {
    // Make sure we have an array of producers
    const producersArray = [...producers.values()];
    return this.updateRoomStream(roomId, router, producersArray);
  }

  /** 
   * Creates or updates a stream for a room using the actual WebRTC video
   */
  public async updateRoomStream(
    roomId: string,
    router: mediasoup.types.Router,
    producers: any[] | any
  ): Promise<string> {
    console.log(`Received producers for room ${roomId}`);
    
    // Ensure producers is an array
    const producersArray = Array.isArray(producers) ? producers : (producers ? [producers] : []);
    
    // Check if producers is empty
    if (producersArray.length === 0) {
      console.log(`No producers available, cannot create stream`);
      throw new Error("No producers available for streaming");
    }
    
    // Get the actual producer objects from the router
    const videoProducers: mediasoup.types.Producer[] = [];
    
    for (const producer of producersArray) {
      if (producer && typeof producer.kind === 'string' && producer.kind === 'video') {
        console.log(`Found video producer: ${producer.id}`);
        videoProducers.push(producer);
      } 
      else if (producer && (typeof producer === 'string' || producer.id)) {
        const producerId = typeof producer === 'string' ? producer : producer.id;
        try {
          const actualProducer = router.getProducerById(producerId);
          if (actualProducer && actualProducer.kind === 'video') {
            console.log(`Got video producer from router: ${actualProducer.id}`);
            videoProducers.push(actualProducer);
          }
        } catch (error) {
          console.error(`Error getting producer ${producerId} from router:`, error.message);
        }
      }
    }

    // Filter to get at most 2 active video producers
    const activeProducers = videoProducers
      .filter(p => !p.closed && !p.paused)
      .slice(0, 2); // Take at most 2
    
    console.log(`Using ${activeProducers.length} active video producers for stream`);
    
    if (activeProducers.length === 0) {
      console.log(`No active video producers available`);
      throw new Error("No active video producers available for streaming");
    }

    // Create the stream
    const result = await this.createSimpleStream(roomId, router, activeProducers);
    return result;
  }

  /**
   * Creates a simple HLS stream with up to 2 participants side by side
   */
  private async createSimpleStream(
    roomId: string,
    router: mediasoup.types.Router,
    producers: mediasoup.types.Producer[]
  ): Promise<string> {
    // Stop any existing stream
    await this.stopRoomHlsStream(roomId);
    
    // Ensure output directory exists
    const roomOutputPath = path.join(this.hlsOutputPath, roomId);
    if (!fs.existsSync(roomOutputPath)) {
      fs.mkdirSync(roomOutputPath, { recursive: true });
    }
    
    console.log(`Room ${roomId} has ${producers.length} video producers`);
    
    // Create RTP transports for each producer
    const plainTransports: mediasoup.types.PlainTransport[] = [];
    const videoConsumers: mediasoup.types.Consumer[] = [];
    const videoPorts: number[] = [];
    
    // Reserve ports with delays to prevent conflicts
    for (let i = 0; i < producers.length; i++) {
      // Use different port ranges for each producer to avoid conflicts
      const portBase = 40000 + (i * 1000); 
      const port = await this.getAvailablePort(portBase, portBase + 100);
      videoPorts.push(port);
      
      // Small delay to ensure OS fully releases ports
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Create transports and consumers
    for (let i = 0; i < producers.length; i++) {
      const producer = producers[i];
      const port = videoPorts[i];
      
      try {
        // Create transport
        const transport = await router.createPlainTransport({
          listenIp: { ip: '127.0.0.1', announcedIp: '127.0.0.1' },
          rtcpMux: true,
          comedia: false
        });
        
        plainTransports.push(transport);
        
        // Connect transport
        await transport.connect({
          ip: '127.0.0.1',
          port: port
        });
        
        // Create consumer
        const consumer = await transport.consume({
          producerId: producer.id,
          rtpCapabilities: router.rtpCapabilities,
          paused: true
        });
        
        videoConsumers.push(consumer);
        
        console.log(`Created transport for producer ${producer.id} on port ${port}`);
      } catch (error) {
        console.error(`Error setting up producer ${producer.id}:`, error);
        
        // Clean up on error
        this.releasePort(port);
        for (const transport of plainTransports) {
          if (!transport.closed) transport.close();
        }
        
        throw error;
      }
    }
    
    // Wait to make sure transports are fully set up
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Create SDP files
    const sdpFiles: string[] = [];
    
    for (let i = 0; i < videoConsumers.length; i++) {
      const consumer = videoConsumers[i];
      const port = videoPorts[i];
      
      // Create SDP content
      const sdpContent = this.createSimpleSdpFile(consumer, port);
      const sdpFilePath = path.join(roomOutputPath, `input_${i}.sdp`);
      fs.writeFileSync(sdpFilePath, sdpContent);
      sdpFiles.push(sdpFilePath);
      
      console.log(`Created SDP file at ${sdpFilePath}`);
    }
    
    try {
      // FFmpeg command
      const ffmpegArgs: string[] = [];
      
      // Global options
      ffmpegArgs.push(
        '-loglevel', this.ffmpegLogLevel,
        '-protocol_whitelist', 'file,udp,rtp,crypto,data'
      );
      
      // Add input files
      for (const sdpFile of sdpFiles) {
        ffmpegArgs.push(
          '-protocol_whitelist', 'file,udp,rtp,crypto,data',
          '-i', sdpFile
        );
      }
      
      // Create silent audio
      ffmpegArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      
      // Set filter based on number of producers
      let filterComplex = '';
      if (producers.length === 1) {
        filterComplex = '[0:v]scale=640:480,fps=30[v]';
      } else {
        filterComplex = '[0:v]scale=320:240,fps=30[v0];[1:v]scale=320:240,fps=30[v1];[v0][v1]hstack=inputs=2[v]';
      }
      
      ffmpegArgs.push('-filter_complex', filterComplex);
      ffmpegArgs.push('-map', '[v]');
      ffmpegArgs.push('-map', `${sdpFiles.length}:a`);
      
      // Video encoding settings
      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-profile:v', 'baseline',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-b:v', '1000k',
        '-maxrate', '1000k',
        '-bufsize', '2000k'
      );
      
      // Audio encoding
      ffmpegArgs.push(
        '-c:a', 'aac',
        '-b:a', '128k'
      );
      
      // HLS output
      ffmpegArgs.push(
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '5',
        '-hls_flags', 'delete_segments+append_list',
        '-hls_segment_filename', path.join(roomOutputPath, 'segment_%03d.ts'),
        path.join(roomOutputPath, 'playlist.m3u8')
      );
      
      console.log(`Starting FFmpeg with command: ffmpeg ${ffmpegArgs.join(' ')}`);
      
      // Start FFmpeg
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
      
      // Store in active rooms
      this._activeRooms.set(roomId, {
        ffmpegProcess,
        plainTransports,
        outputPath: roomOutputPath,
      });
      
      // Handle process output
      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output && !output.includes('VBV underflow') && !output.includes('frames duplicated')) {
          console.log(`FFmpeg [${roomId}]: ${output}`);
        }
      });
      
      // Resume consumers after FFmpeg has started
      setTimeout(async () => {
        if (ffmpegProcess.exitCode === null) {
          for (const consumer of videoConsumers) {
            await consumer.resume();
            await consumer.requestKeyFrame();
          }
          console.log(`Resumed ${videoConsumers.length} consumers for room ${roomId}`);
        }
      }, 2000);
      
      // Handle process exit
      ffmpegProcess.on('close', (code) => {
        console.log(`FFmpeg process exited with code ${code}`);
        
        // Clean up
        for (const port of videoPorts) {
          this.releasePort(port);
        }
        
        for (const transport of plainTransports) {
          if (!transport.closed) {
            try {
              transport.close();
            } catch (err) {
              console.error(`Error closing transport: ${err.message}`);
            }
          }
        }
        
        const roomState = this._activeRooms.get(roomId);
        if (roomState && roomState.ffmpegProcess === ffmpegProcess) {
          this._activeRooms.delete(roomId);
        }
      });
      
      return `/hls/${roomId}/playlist.m3u8`;
    } catch (error) {
      console.error(`Error starting FFmpeg:`, error);
      
      // Clean up on error
      for (const port of videoPorts) {
        this.releasePort(port);
      }
      
      for (const transport of plainTransports) {
        if (!transport.closed) transport.close();
      }
      
      throw error;
    }
  }

  /**
   * Creates a simple SDP file for a video consumer
   */
  private createSimpleSdpFile(
    consumer: mediasoup.types.Consumer,
    port: number
  ): string {
    const codec = consumer.rtpParameters.codecs[0];
    
    let sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=MediaSoup HLS
c=IN IP4 127.0.0.1
t=0 0
m=video ${port} RTP/AVP ${codec.payloadType}
a=rtpmap:${codec.payloadType} ${codec.mimeType.split('/')[1]}/${codec.clockRate}
a=recvonly
`;
    
    // Add fmtp line if parameters exist
    if (codec.parameters) {
      const params = Object.entries(codec.parameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(';');
      
      if (params) {
        sdp += `a=fmtp:${codec.payloadType} ${params}\n`;
      }
    }
    
    // Add ssrc if available
    for (const encoding of consumer.rtpParameters.encodings) {
      if (encoding.ssrc) {
        sdp += `a=ssrc:${encoding.ssrc} cname:mediasoup\n`;
      }
    }
    
    return sdp;
  }

  /**
   * Stops an existing HLS stream for a room
   */
  public async stopRoomHlsStream(roomId: string): Promise<void> {
    const state = this._activeRooms.get(roomId);
    if (!state) return;
    
    console.log(`Stopping HLS for room ${roomId}`);
    
    // Stop FFmpeg process
    if (state.ffmpegProcess) {
      try {
        state.ffmpegProcess.kill('SIGINT');
        
        // Wait for the process to exit gracefully
        await new Promise<void>((resolve) => {
          if (!state.ffmpegProcess) {
            resolve();
            return;
          }
          
          // Set a timeout in case the process doesn't exit
          const timeout = setTimeout(() => {
            if (state.ffmpegProcess) {
              try {
                state.ffmpegProcess.kill('SIGKILL');
              } catch (e) {}
            }
            resolve();
          }, 3000);
          
          state.ffmpegProcess.once('close', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch (err) {
        console.error(`Error stopping FFmpeg process: ${err.message}`);
      }
    }
    
    // Close transports
    for (const transport of state.plainTransports) {
      if (!transport.closed) {
        try {
          transport.close();
        } catch (err) {
          console.error(`Error closing transport: ${err.message}`);
        }
      }
    }
    
    this._activeRooms.delete(roomId);
    console.log(`Stopped HLS for room ${roomId}`);
  }

  /**
   * Gets the HLS URL for a room
   */
  public getHlsUrl(roomId: string): string {
    return `/hls/${roomId}/playlist.m3u8`;
  }
  
  /**
   * Finds an available port
   */
  private async getAvailablePort(min: number, max: number): Promise<number> {
    // Try each port in the range
    for (let port = min; port <= max; port++) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    
    // If all ports in range are used, try a random port
    for (let i = 0; i < 20; i++) {
      const randomPort = Math.floor(Math.random() * 10000) + 50000; // Random port between 50000-60000
      if (!this.usedPorts.has(randomPort)) {
        this.usedPorts.add(randomPort);
        return randomPort;
      }
    }
    
    throw new Error('No available ports found');
  }

  /**
   * Releases a used port
   */
  private releasePort(port: number): void {
    this.usedPorts.delete(port);
    console.log(`Released port ${port}`);
  }
}