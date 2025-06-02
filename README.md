# Fermion WebRTC Project

A WebRTC-based video streaming solution built with MediaSoup, Next.js, and Socket.IO that supports distinct streamer and viewer roles.

## Features

- **Real-time Video Streaming**: Built on WebRTC for low-latency video delivery
- **MediaSoup Integration**: Uses MediaSoup as Selective Forwarding Unit (SFU)
- **Role-Based Access**: Separate interfaces for streamers and watchers
- **Scalable Architecture**: Supports multiple producers and consumers
- **Robust Media Codecs**: Audio (Opus) and Video (VP8) support
- **Reliable Transport**: Both UDP and TCP fallback support
- **Modern Frontend**: Built with Next.js and React

## Technical Stack

### Backend
- Express.js
- MediaSoup (WebRTC SFU)
- Socket.IO
- TypeScript

### Frontend
- Next.js
- React
- TypeScript
- Tailwind CSS

## Role-Based Access Control

### Streamer Role
- Full access to camera and microphone controls
- Ability to produce media streams
- Available at `/stream`

### Watcher Role
- View-only interface for consuming streams
- Media production controls are hidden
- Available at `/watch`

## Server Configuration

### Media Codecs
- **Audio**: Opus (48kHz, 2 channels)
- **Video**: VP8 with NACK and FIR support
- **Bitrate**: Configurable starting at 1000kbps

### Network Settings
- **Port Range**: 2000-2020 (WebRTC)
- **Server Port**: 4000
- **Frontend Port**: 3000
- **Transport**: UDP (preferred) with TCP fallback
- **CORS**: Enabled for all origins

## Architecture

### Core Components

1. **MediaSoup Worker**
   - Handles media routing
   - Automatic recovery on crashes
   - Process monitoring

2. **WebRTC Transport**
   - Separate producer and consumer transports
   - DTLS state management
   - ICE candidate handling

3. **Media Handling**
   - Producer management
   - Consumer management
   - Stream synchronization

4. **Next.js Frontend**
   - Responsive UI with Tailwind CSS
   - Role-based component rendering
   - URL parameter handling

## Getting Started

1. Install dependencies:
```bash
npm install
```

2. Start the backend server:
```bash
npm run server
```

3. In a separate terminal, start the frontend:
```bash
npm run dev
```

4. Frontend will be available at `https://localhost:3000`
5. Backend will be running at `http://localhost:4000`

## User Flow

1. Visit the home page at `https://localhost:3000`
2. Enter a room ID and username
3. Choose to join as a "Streamer" or "Watcher"
4. The application will load the appropriate interface based on your role

## API Reference

### Socket.IO Events

| Event | Description |
|-------|-------------|
| `connection-success` | Initial peer connection established |
| `join-room` | Join a specific room with role |
| `getRouterRtpCapabilities` | Get router capabilities |
| `createTransport` | Create WebRTC transport |
| `connectProducerTransport` | Connect producer |
| `transport-produce` | Start media production |
| `connectConsumerTransport` | Connect consumer |
| `consumeMedia` | Start media consumption |
| `new-producer` | Notification of new stream available |

## Development

### Requirements
- Node.js 16+
- npm or yarn
- TypeScript understanding
- WebRTC knowledge
- React/Next.js experience

## Contributing

1. Fork the repository
2. Create feature branch
3. Commit changes
4. Push to branch
5. Create Pull Request

## License

MIT License

---

For detailed API documentation or contribution guidelines, please refer to the docs directory.