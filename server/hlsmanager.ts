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
  // Log counters for tracking duplicate warnings
  private duplicateFrameCounters: Map<string, number> = new Map();
  // Counter for RTP packet loss warnings
  private rtpPacketLossCounters: Map<string, number> = new Map();

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
      console.log(`No producers available, cannot create WebRTC stream`);
      throw new Error("No producers available for streaming");
    }
    
    console.log(`Processing ${producersArray.length} producers for room ${roomId}`);
  
    try {
      // Get the actual producer objects from the router using the producer ids
      const realProducers: mediasoup.types.Producer[] = [];
      
      for (const producer of producersArray) {
        // Log the producer to help debug
        console.log(`Producer details:`, JSON.stringify({
          id: producer?.id,
          kind: producer?.kind,
          type: typeof producer
        }));
        
        // If we already have a real producer object with kind property
        if (producer && typeof producer.kind === 'string') {
          console.log(`Found real producer: ${producer.id}, kind: ${producer.kind}`);
          realProducers.push(producer);
        } 
        // If we have a producer ID or an object with an ID
        else if (producer && (typeof producer === 'string' || producer.id)) {
          const producerId = typeof producer === 'string' ? producer : producer.id;
          console.log(`Looking up producer by ID: ${producerId}`);
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
        throw new Error("No active producers available for streaming");
      }
  
      // Create the WebRTC stream with the direct RTP approach
      const result = await this.createMultiParticipantStream(roomId, router, activeProducers);
      return result;
    } catch (error) {
      console.error(`Error creating WebRTC stream: ${error.message}`);
      throw error;
    }
  }

  /**
   * Creates an HLS stream with multiple participants in a grid layout
   */
  private async createMultiParticipantStream(
    roomId: string,
    router: mediasoup.types.Router,
    producers: mediasoup.types.Producer[]
  ): Promise<string> {
    // Stop any existing stream
    await this.stopRoomHlsStream(roomId);
    
    // Reset warning counters for this room
    this.duplicateFrameCounters.set(roomId, 0);
    this.rtpPacketLossCounters.set(roomId, 0);
    
    const roomOutputPath = path.join(this.hlsOutputPath, roomId);
    if (!fs.existsSync(roomOutputPath)) {
      fs.mkdirSync(roomOutputPath, { recursive: true });
    }
    
    // Separate video and audio producers
    const videoProducers = producers.filter(p => p.kind === 'video');
    const audioProducers = producers.filter(p => p.kind === 'audio');
    
    console.log(`Room ${roomId} has ${videoProducers.length} video and ${audioProducers.length} audio producers`);
    
    if (videoProducers.length === 0) {
      console.log(`No video producers available for room ${roomId}`);
      throw new Error("No video producers available");
    }
    
    // Use up to 4 video producers for a 2x2 grid
    const maxVideoProducers = Math.min(videoProducers.length, 4);
    const selectedVideoProducers = videoProducers.slice(0, maxVideoProducers);
    
    // Use the first audio producer (we'll mix audio if there are multiple)
    const audioProducer = audioProducers.length > 0 ? audioProducers[0] : null;
    
    console.log(`Using ${selectedVideoProducers.length} video producers for grid layout`);
    
    // Create RTP transports for each producer
    const plainTransports: mediasoup.types.PlainTransport[] = [];
    const videoConsumers: mediasoup.types.Consumer[] = [];
    const videoPortMap: Map<string, number> = new Map();
    
    // Get all required ports first to ensure no conflicts
    const videoPorts: number[] = [];
    let audioPort = 0;

    // Reserve all needed ports first
    for (let i = 0; i < selectedVideoProducers.length; i++) {
      const port = await this.getPortFromRange(40000, 40100);
      videoPorts.push(port);
    }
    
    if (audioProducer) {
      audioPort = await this.getPortFromRange(40101, 40200);
    }
    
    // Create transports and consumers for each video producer
    for (let i = 0; i < selectedVideoProducers.length; i++) {
      const videoProducer = selectedVideoProducers[i];
      const videoPort = videoPorts[i];
      
      try {
        // Create transport for this video producer
        const videoTransport = await router.createPlainTransport({
          listenIp: { ip: '127.0.0.1', announcedIp: '127.0.0.1' },
          rtcpMux: true,
          comedia: false
        });
        plainTransports.push(videoTransport);
        
        videoPortMap.set(videoProducer.id, videoPort);
        
        // Connect the transport
        await videoTransport.connect({
          ip: '127.0.0.1',
          port: videoPort
        });
        
        // Create consumer
        const videoConsumer = await videoTransport.consume({
          producerId: videoProducer.id,
          rtpCapabilities: router.rtpCapabilities,
          paused: true
        });
        
        videoConsumers.push(videoConsumer);
        
        console.log(`Created transport for video producer ${videoProducer.id} on port ${videoPort}`);
      } catch (error) {
        console.error(`Error creating transport for producer ${videoProducer.id}:`, error);
        // Release port on error
        this.releasePort(videoPort);
        throw error;
      }
    }
    
    // Variables for audio transport and consumer
    let audioTransport: mediasoup.types.PlainTransport | null = null;
    let audioConsumer: mediasoup.types.Consumer | null = null;
    
    // If we have audio, set up the audio transport too
    if (audioProducer) {
      try {
        audioTransport = await router.createPlainTransport({
          listenIp: { ip: '127.0.0.1', announcedIp: '127.0.0.1' },
          rtcpMux: true,
          comedia: false
        });
        plainTransports.push(audioTransport);
        
        await audioTransport.connect({
          ip: '127.0.0.1',
          port: audioPort
        });
        
        audioConsumer = await audioTransport.consume({
          producerId: audioProducer.id,
          rtpCapabilities: router.rtpCapabilities,
          paused: true
        });
        
        console.log(`Created transport for audio producer ${audioProducer.id} on port ${audioPort}`);
      } catch (error) {
        console.error(`Error creating audio transport:`, error);
        this.releasePort(audioPort);
        throw error;
      }
    }
    
    // Add a small delay to ensure transports are fully set up
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Create an SDP file for each video consumer
    const sdpFiles: string[] = [];
    
    for (let i = 0; i < videoConsumers.length; i++) {
      const videoConsumer = videoConsumers[i];
      const videoPort = videoPortMap.get(selectedVideoProducers[i].id)!;
      
      // Create SDP content for this consumer (video only)
      const sdpContent = this.createSdpFile(videoConsumer, videoPort, null, 0);
      const sdpFilePath = path.join(roomOutputPath, `input_video_${i}.sdp`);
      fs.writeFileSync(sdpFilePath, sdpContent);
      sdpFiles.push(sdpFilePath);
      
      console.log(`Created SDP file for video ${i} at ${sdpFilePath}`);
    }
    
    // Create SDP file for audio if available
    let audioSdpFile = '';
    if (audioConsumer && audioPort) {
      const sdpContent = this.createSdpFile(null, 0, audioConsumer, audioPort);
      audioSdpFile = path.join(roomOutputPath, 'input_audio.sdp');
      fs.writeFileSync(audioSdpFile, sdpContent);
      console.log(`Created SDP file for audio at ${audioSdpFile}`);
    }
    
    try {
      // FFmpeg command to consume the RTP streams and output HLS with grid layout
      const ffmpegArgs: string[] = [];

      // Set global options that must come before input options
      ffmpegArgs.push(
        // Set log level
        '-loglevel', this.ffmpegLogLevel,
        // Important: this must come before any inputs
        '-protocol_whitelist', 'file,udp,rtp,crypto,data',
        // Increase buffer sizes and timeouts to help with packet loss
        '-thread_queue_size', '1024',
        '-reorder_queue_size', '4096'
      );
      
      // Input all video SDP files with individual input options for each
      for (const sdpFile of sdpFiles) {
        // Add input-specific options with protocol whitelist for each input
        ffmpegArgs.push(
          '-protocol_whitelist', 'file,udp,rtp,crypto,data',  // Add whitelist for each input explicitly
          '-fflags', '+genpts',
          '-i', sdpFile
        );
      }
      
      // Add audio input if available
      if (audioSdpFile) {
        ffmpegArgs.push(
          '-protocol_whitelist', 'file,udp,rtp,crypto,data',  // Add whitelist for audio input too
          '-fflags', '+genpts',
          '-i', audioSdpFile
        );
      } else {
        // Create silent audio if no audio input
        ffmpegArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      }
      
      // Create a filter complex for grid layout
      let filterComplex = '';
      
      // Determine grid layout based on number of participants
      const numParticipants = selectedVideoProducers.length;
      
      if (numParticipants === 1) {
        // Just one participant, no grid needed
        filterComplex = '[0:v]scale=640:480,fps=30[v]';
      } else if (numParticipants === 2) {
        // Two participants side by side
        filterComplex = '[0:v]scale=320:240,fps=30[v0];[1:v]scale=320:240,fps=30[v1];[v0][v1]hstack=inputs=2[v]';
      } else if (numParticipants === 3) {
        // Three participants in a T shape
        filterComplex = '[0:v]scale=320:240,fps=30[v0];[1:v]scale=320:240,fps=30[v1];[2:v]scale=640:240,fps=30[v2];' +
                       '[v0][v1]hstack=inputs=2[top];[top][v2]vstack=inputs=2[v]';
      } else if (numParticipants === 4) {
        // Four participants in a 2x2 grid
        filterComplex = '[0:v]scale=320:240,fps=30[v0];[1:v]scale=320:240,fps=30[v1];[2:v]scale=320:240,fps=30[v2];[3:v]scale=320:240,fps=30[v3];' +
                       '[v0][v1]hstack=inputs=2[top];[v2][v3]hstack=inputs=2[bottom];[top][bottom]vstack=inputs=2[v]';
      }
      
      // Add filter complex
      ffmpegArgs.push('-filter_complex', filterComplex);
      ffmpegArgs.push('-map', '[v]');  // Map the video from filter output
      
      // Map the audio (either from input or generated silent audio)
      const audioInputIndex = sdpFiles.length;
      ffmpegArgs.push('-map', `${audioInputIndex}:a`);
      
      // Video encoding settings
      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-profile:v', 'baseline',
        '-pix_fmt', 'yuv420p',
        '-g', '30',
        '-keyint_min', '30',
        '-sc_threshold', '0',
        '-b:v', '1500k',
        '-minrate', '1500k',
        '-maxrate', '1500k',
        '-bufsize', '3000k',
        '-fps_mode', 'cfr',
        '-r', '30',
        '-x264opts', 'no-scenecut:nal-hrd=cbr:bitrate=1500:vbv-maxrate=1500:vbv-bufsize=3000',
        '-force_key_frames', 'expr:gte(t,n_forced*2)'
      );
      
      // Audio encoding settings
      ffmpegArgs.push(
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2'
      );
      
      // HLS output settings
      ffmpegArgs.push(
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '5',
        '-hls_flags', 'delete_segments+append_list+independent_segments+program_date_time',
        '-hls_segment_type', 'mpegts',
        '-hls_init_time', '0',
        '-hls_segment_filename', path.join(roomOutputPath, 'segment_%03d.ts'),
        path.join(roomOutputPath, 'playlist.m3u8')
      );
      
      console.log(`Starting FFmpeg with command: ffmpeg ${ffmpegArgs.join(' ')}`);
      
      // Start FFmpeg process
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
      
      // Store in active rooms - do this early so we can handle early exits
      this._activeRooms.set(roomId, {
        ffmpegProcess,
        plainTransports,
        outputPath: roomOutputPath,
      });

      // Setup process handlers
      this.setupFFmpegProcessHandlers(ffmpegProcess, roomId, videoConsumers, audioConsumer, videoPortMap, audioPort, plainTransports);
      
      return `/hls/${roomId}/playlist.m3u8`;
    } catch (error) {
      // Clean up on error
      console.error("Error starting FFmpeg process:", error);
      
      // Close transports
      for (const transport of plainTransports) {
        if (!transport.closed) {
          transport.close();
        }
      }
      
      // Release ports
      for (const port of videoPorts) {
        this.releasePort(port);
      }
      
      if (audioPort) {
        this.releasePort(audioPort);
      }
      
      throw error;
    }
  }

  /**
   * Setup FFmpeg process event handlers
   */
  private setupFFmpegProcessHandlers(
    ffmpegProcess: ChildProcess,
    roomId: string,
    videoConsumers: mediasoup.types.Consumer[],
    audioConsumer: mediasoup.types.Consumer | null,
    videoPortMap: Map<string, number>,
    audioPort: number,
    plainTransports: mediasoup.types.PlainTransport[]
  ): void {
    // Capture FFmpeg output for debugging with improved filtering
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Handle duplicate frames warning more gracefully
      if (output.includes('frames duplicated')) {
        // Only log duplicated frames warnings occasionally to avoid console spam
        const counter = (this.duplicateFrameCounters.get(roomId) || 0) + 1;
        this.duplicateFrameCounters.set(roomId, counter);
        
        if (counter % 50 === 0) {
          console.log(`FFmpeg [Room ${roomId}]: ${output.trim()} (showing 1 of 50 duplicate warnings)`);
        }
      } 
      // Handle RTP packet loss warnings
      else if (output.includes('RTP: missed') || output.includes('max delay reached') || 
              output.includes('dropping old packet') || output.includes('RTP: dropping')) {
        // Track and limit packet loss warnings
        const counter = (this.rtpPacketLossCounters.get(roomId) || 0) + 1;
        this.rtpPacketLossCounters.set(roomId, counter);
        
        if (counter % 20 === 0) {
          console.log(`FFmpeg [Room ${roomId}]: ${output.trim()} (showing 1 of 20 packet loss warnings)`);
        }
      }
      // Filter out other common log spam
      else if (!output.includes('VBV underflow') && 
          !/\[libx264 @ [0-9a-z]+\]\s*$/.test(output) && 
          output.trim().length > 0) {
        console.log(`FFmpeg [Room ${roomId}]: ${output.trim()}`);
      }
    });
    
    // Resume the consumers after FFmpeg has started
    setTimeout(async () => {
      try {
        // Check if the FFmpeg process is still running before resuming consumers
        if (ffmpegProcess.exitCode === null) {
          // Resume all video consumers
          for (const consumer of videoConsumers) {
            await consumer.resume();
            await consumer.requestKeyFrame();
          }
          
          // Resume audio consumer if available
          if (audioConsumer) {
            await audioConsumer.resume();
          }
          
          console.log(`Resumed ${videoConsumers.length} video consumers and ${audioConsumer ? '1' : '0'} audio consumers for room ${roomId}`);
        } else {
          console.log(`Cannot resume consumers for room ${roomId} - FFmpeg process already exited with code ${ffmpegProcess.exitCode}`);
        }
      } catch (error) {
        console.error('Error resuming consumers:', error);
      }
    }, 1000);
    
    // Handle FFmpeg exit
    ffmpegProcess.on('close', (code) => {
      console.log(`FFmpeg exited with code ${code} for room ${roomId}`);
      
      // Release ports
      for (const port of videoPortMap.values()) {
        this.releasePort(port);
      }
      
      if (audioPort) {
        this.releasePort(audioPort);
      }
      
      // Close transports
      for (const transport of plainTransports) {
        if (!transport.closed) {
          try {
            transport.close();
          } catch (err) {
            console.error(`Error closing transport: ${err.message}`);
          }
        }
      }
      
      // Clean up counters
      this.duplicateFrameCounters.delete(roomId);
      this.rtpPacketLossCounters.delete(roomId);
      
      // If the process was part of an active room, remove it
      const roomState = this._activeRooms.get(roomId);
      if (roomState && roomState.ffmpegProcess === ffmpegProcess) {
        this._activeRooms.delete(roomId);
      }
    });
  }

  public async stopRoomHlsStream(roomId: string): Promise<void> {
    const state = this._activeRooms.get(roomId);
    if (!state) return;
    
    if (state.ffmpegProcess) {
      try {
        state.ffmpegProcess.kill('SIGINT');
      } catch (err) {
        console.error(`Error stopping FFmpeg process: ${err.message}`);
      }
    }
    
    for (const t of state.plainTransports) {
      try {
        if (!t.closed) {
          t.close();
        }
      } catch (err) {
        console.error(`Error closing transport: ${err.message}`);
      }
    }
    
    this._activeRooms.delete(roomId);
    this.duplicateFrameCounters.delete(roomId);
    this.rtpPacketLossCounters.delete(roomId);
    console.log(`Stopped HLS for room ${roomId}`);
  }

  public getHlsUrl(roomId: string): string {
    return `/hls/${roomId}/playlist.m3u8`;
  }
  
  // Helper method to create an SDP file from the consumer information
  private createSdpFile(
    videoConsumer: mediasoup.types.Consumer | null,
    videoPort: number,
    audioConsumer: mediasoup.types.Consumer | null,
    audioPort: number
  ): string {
    let sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=MediaSoup HLS
c=IN IP4 127.0.0.1
t=0 0
`;

    // Add video media section if provided
    if (videoConsumer && videoPort) {
      sdp += `m=video ${videoPort} RTP/AVP ${videoConsumer.rtpParameters.codecs[0].payloadType}\n`;
      sdp += `a=rtpmap:${videoConsumer.rtpParameters.codecs[0].payloadType} ${videoConsumer.rtpParameters.codecs[0].mimeType.split('/')[1]}/${videoConsumer.rtpParameters.codecs[0].clockRate}\n`;
      sdp += `a=recvonly\n`;  // Change to recvonly (from FFmpeg's perspective)
      
      // Add any video codec parameters
      if (videoConsumer.rtpParameters.codecs[0].parameters) {
        const params = [];
        for (const [key, value] of Object.entries(videoConsumer.rtpParameters.codecs[0].parameters)) {
          params.push(`${key}=${value}`);
        }
        if (params.length > 0) {
          sdp += `a=fmtp:${videoConsumer.rtpParameters.codecs[0].payloadType} ${params.join(';')}\n`;
        }
      }
      
      // Add rtcp feedback parameters
      if (videoConsumer.rtpParameters.codecs[0].rtcpFeedback) {
        for (const fb of videoConsumer.rtpParameters.codecs[0].rtcpFeedback) {
          sdp += `a=rtcp-fb:${videoConsumer.rtpParameters.codecs[0].payloadType} ${fb.type}${fb.parameter ? ' ' + fb.parameter : ''}\n`;
        }
      }
      
      // Add video RTP header extensions
      for (const ext of videoConsumer.rtpParameters.headerExtensions) {
        sdp += `a=extmap:${ext.id} ${ext.uri}\n`;
      }
      
      // Add video ssrc information
      for (const encoding of videoConsumer.rtpParameters.encodings) {
        if (encoding.ssrc) {
          sdp += `a=ssrc:${encoding.ssrc} cname:mediasoup\n`;
        }
      }
    }
    
    // Add audio media section if provided
    if (audioConsumer && audioPort) {
      sdp += `m=audio ${audioPort} RTP/AVP ${audioConsumer.rtpParameters.codecs[0].payloadType}\n`;
      sdp += `a=rtpmap:${audioConsumer.rtpParameters.codecs[0].payloadType} ${audioConsumer.rtpParameters.codecs[0].mimeType.split('/')[1]}/${audioConsumer.rtpParameters.codecs[0].clockRate}/${audioConsumer.rtpParameters.codecs[0].channels || 2}\n`;
      sdp += `a=recvonly\n`;  // Change to recvonly (from FFmpeg's perspective)
      
      // Add any audio codec parameters
      if (audioConsumer.rtpParameters.codecs[0].parameters) {
        const params = [];
        for (const [key, value] of Object.entries(audioConsumer.rtpParameters.codecs[0].parameters)) {
          params.push(`${key}=${value}`);
        }
        if (params.length > 0) {
          sdp += `a=fmtp:${audioConsumer.rtpParameters.codecs[0].payloadType} ${params.join(';')}\n`;
        }
      }
      
      // Add audio RTP header extensions
      for (const ext of audioConsumer.rtpParameters.headerExtensions) {
        sdp += `a=extmap:${ext.id} ${ext.uri}\n`;
      }
      
      // Add audio ssrc information
      for (const encoding of audioConsumer.rtpParameters.encodings) {
        if (encoding.ssrc) {
          sdp += `a=ssrc:${encoding.ssrc} cname:mediasoup\n`;
        }
      }
    }
    
    return sdp;
  }
  
  // Port management utilities with improved handling
  private async getPortFromRange(min: number, max: number): Promise<number> {
    // Try to find an unused port in the range
    for (let port = min; port <= max; port++) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    
    // If we reach here, all ports in the normal range are in use
    // Try to find a port outside the normal range as a fallback
    for (let port = max + 1; port < 65535; port++) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    
    throw new Error('No available ports found');
  }

  private releasePort(port: number): void {
    this.usedPorts.delete(port);
    console.log(`Released port ${port}`);
  }
}