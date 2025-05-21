# Fermion WebRTC Project

A WebRTC-based video streaming solution built with MediaSoup, Express, and Socket.IO.

## Features

- **Real-time Video Streaming**: Built on WebRTC for low-latency video delivery
- **MediaSoup Integration**: Uses MediaSoup as Selective Forwarding Unit (SFU)
- **Scalable Architecture**: Supports multiple producers and consumers
- **Robust Media Codecs**: Audio (Opus) and Video (VP8) support
- **Reliable Transport**: Both UDP and TCP fallback support

## Technical Stack

### Backend
- Express.js
- MediaSoup (WebRTC SFU)
- Socket.IO
- TypeScript

## Server Configuration

### Media Codecs
- **Audio**: Opus (48kHz, 2 channels)
- **Video**: VP8 with NACK and FIR support
- **Bitrate**: Configurable starting at 1000kbps

### Network Settings
- **Port Range**: 2000-2020 (WebRTC)
- **Server Port**: 4000
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

## Getting Started

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm run dev
```

3. Server will be running at `http://localhost:4000`

## API Reference

### Socket.IO Events

| Event | Description |
|-------|-------------|
| `connection` | Initial peer connection |
| `getRouterRtpCapabilities` | Get router capabilities |
| `createTransport` | Create WebRTC transport |
| `connectProducerTransport` | Connect producer |
| `transport-produce` | Start media production |
| `connectConsumerTransport` | Connect consumer |
| `consumeMedia` | Start media consumption |
| `resumePausedConsumer` | Resume paused streams |

## Development

### Requirements
- Node.js 16+
- npm or yarn
- TypeScript understanding
- WebRTC knowledge

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