import * as mediasoup from 'mediasoup';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import express from 'express';

export class HlsManager {
  private hlsOutputPath: string;
  private app: express.Application;
  private activeRooms: Map<string, {
    ffmpegProcess: ChildProcess | null;
    plainTransports: mediasoup.types.PlainTransport[];
    outputPath: string;
  }>;

  constructor(app: express.Application, outputPath: string = path.join(__dirname, 'public', 'hls')) {
    this.hlsOutputPath = outputPath;
    this.app = app;
    this.activeRooms = new Map();
    
    // Create output directory if it doesn't exist
    if (!fs.existsSync(this.hlsOutputPath)) {
      fs.mkdirSync(this.hlsOutputPath, { recursive: true });
    }
    
    // Serve HLS files
    this.app.use('/hls', express.static(this.hlsOutputPath));
      console.log(`HLS manager initialized. Files will be saved to ${this.hlsOutputPath}`);
    console.log(`HLS streams will be available at http(s)://[server-address]/hls/[roomId]/playlist.m3u8`);
    
    console.log(`HLS manager initialized. Files will be saved to ${this.hlsOutputPath}`);
  }

  /**
   * Start HLS streaming for a room
   */
    async createRoomHlsStream(roomId: string, router: mediasoup.types.Router, producers: Map<string, mediasoup.types.Producer>): Promise<string> {
      // Stop existing stream if any
      await this.stopRoomHlsStream(roomId);
  
      const roomOutputPath = path.join(this.hlsOutputPath, roomId);
      if (!fs.existsSync(roomOutputPath)) {
        fs.mkdirSync(roomOutputPath, { recursive: true });
      }
  
      const transports: mediasoup.types.PlainTransport[] = [];
      const inputArgs: string[] = [];
      
      // Create a plain transport for each producer
      let index = 0;
      for (const producer of producers.values()) {
        if (producer.kind === 'video') {
          // Create a Plain transport to receive media over RTP
          const transport = await router.createPlainTransport({
            listenIp: { ip: '127.0.0.1', announcedIp: null },
            rtcpMux: true,
            comedia: true
          });
          
          // Create a consumer for the producer
          await transport.consume({
            producerId: producer.id,
            rtpCapabilities: router.rtpCapabilities,
            paused: false
          });
          
          // Add input for this stream
          inputArgs.push('-i', `rtp://127.0.0.1:${transport.tuple.localPort}`);
          transports.push(transport);
          index++;
        }
      }
      
      if (transports.length === 0) {
        console.log(`No video producers in room ${roomId}, HLS stream not started`);
        return '';
      }
  
      // Build FFmpeg filter for side-by-side layout
      let filterComplex = '';
      if (transports.length === 1) {
        // Just one stream, no need for complex layout
        filterComplex = '';
      } else if (transports.length === 2) {
        // Two streams side by side
        filterComplex = '-filter_complex "[0:v]scale=960:540[left];[1:v]scale=960:540[right];[left][right]hstack=inputs=2[v]" -map "[v]"';
      } else {
        // Grid layout for more than 2 streams
        const cols = Math.ceil(Math.sqrt(transports.length));
        const rows = Math.ceil(transports.length / cols);
        
        // Scale each input
        const scaledStreams = [];
        for (let i = 0; i < transports.length; i++) {
          filterComplex += `[${i}:v]scale=640:360[v${i}];`;
          scaledStreams.push(`[v${i}]`);
        }
        
        // Create grid layout
        for (let row = 0; row < rows; row++) {
          const rowStreams = [];
          for (let col = 0; col < cols; col++) {
            const index = row * cols + col;
            if (index < transports.length) {
              rowStreams.push(`[v${index}]`);
            }
          }
          if (rowStreams.length > 0) {
            filterComplex += `${rowStreams.join('')}hstack=inputs=${rowStreams.length}[row${row}];`;
          }
        }
        
        // Stack rows vertically
        const rowOutputs = [];
        for (let row = 0; row < rows; row++) {
          rowOutputs.push(`[row${row}]`);
        }
        filterComplex += `${rowOutputs.join('')}vstack=inputs=${rows}[v]" -map "[v]`;
      }
      
      // Prepare FFmpeg command
      const ffmpegArgs = [
        ...inputArgs,
        ...(filterComplex ? ['-filter_complex', filterComplex] : []),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-g', '60', // Keyframe interval
        '-sc_threshold', '0',
        '-hls_time', '2',
        '-hls_list_size', '10',
        '-hls_flags', 'delete_segments+append_list',
        '-hls_segment_filename', path.join(roomOutputPath, 'segment_%03d.ts'),
        path.join(roomOutputPath, 'playlist.m3u8')
      ];
  
      // Before starting FFmpeg process, log the command
      const ffmpegCommand = `ffmpeg ${ffmpegArgs.join(' ')}`;
      console.log('Starting FFmpeg process with command:');
      console.log(ffmpegCommand);
      
      // Start FFmpeg process
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
      
      // After the process is started, log the playlist path
      const playlistPath = path.join(roomOutputPath, 'playlist.m3u8');
      console.log(`HLS playlist will be available at: ${playlistPath}`);
      console.log(`HLS URL: /hls/${roomId}/playlist.m3u8`);
      
      ffmpegProcess.stdout.on('data', (data) => {
        console.log(`FFmpeg stdout: ${data}`);
      });
  
      ffmpegProcess.stderr.on('data', (data) => {
        console.log(`FFmpeg stderr: ${data.toString()}`);
      });
  
      ffmpegProcess.on('close', (code) => {
        console.log(`FFmpeg process for room ${roomId} exited with code ${code}`);
        this.stopRoomHlsStream(roomId);
      });
  
      // Store room data
      this.activeRooms.set(roomId, {
        ffmpegProcess,
        plainTransports: transports,
        outputPath: roomOutputPath
      });
      
      return `/hls/${roomId}/playlist.m3u8`;
    }

  /**
   * Stop HLS streaming for a room
   */
  async stopRoomHlsStream(roomId: string): Promise<void> {
    const roomData = this.activeRooms.get(roomId);
    if (roomData) {
      // Kill FFmpeg process if running
      if (roomData.ffmpegProcess) {
        roomData.ffmpegProcess.kill('SIGINT');
      }
      
      // Close all transports
      for (const transport of roomData.plainTransports) {
        transport.close();
      }
      
      this.activeRooms.delete(roomId);
      console.log(`Stopped HLS stream for room ${roomId}`);
    }
  }

  /**
   * Get HLS URL for a room
   */
  getHlsUrl(roomId: string): string {
    return `/hls/${roomId}/playlist.m3u8`;
  }

  /**
   * Update room stream when producers change
   */
  async updateRoomStream(roomId: string, router: mediasoup.types.Router, producers: Map<string, mediasoup.types.Producer>): Promise<string> {
    return this.createRoomHlsStream(roomId, router, producers);
  }
}