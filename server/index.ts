import express from 'express';
import fs from 'fs';
import path from 'path';
import https from 'httpolyglot';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';
import config from './config';
import Room from './room';
import Peer from './peer';
import { HlsManager } from './hlsmanager';

const app = express();
const options = {
  key: fs.readFileSync(path.join(__dirname, config.sslKey), 'utf-8'),
  cert: fs.readFileSync(path.join(__dirname, config.sslCrt), 'utf-8')
};

const httpsServer = https.createServer(options, app);
const io = new Server(httpsServer, {
  cors: {
    origin: '*',
    credentials: true
  }
});

app.use(express.static(path.join(__dirname, '..', 'test')));

const hlsManager = new HlsManager(app);

// Add a new endpoint to serve the HLS viewer page
app.get('/watch/:roomId', (req, res) => {
  const roomId = req.params.roomId;

  // (Optional) check if folder actually exists:
  const playlistPath = path.join(__dirname, '..', 'public', 'hls', roomId, 'playlist.m3u8');
  if (!fs.existsSync(playlistPath)) {
    return res.status(404).send('No live stream for this room yet.');
  }

  // Serve a simple HTML page with HLS.js
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Watch Room ${roomId}</title>
        <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
        <style>
          body { margin: 0; display: flex; flex-direction: column; align-items: center; }
          video { width: 100%; max-width: 1280px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <h1>Live Stream: Room ${roomId}</h1>
        <video id="liveVideo" controls autoplay playsinline></video>
        <script>
          const video = document.getElementById('liveVideo');
          const hlsUrl = '/hls/${roomId}/playlist.m3u8';

          if (Hls.isSupported()) {
            const hls = new Hls();
            hls.loadSource(hlsUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              video.play();
            });
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari fallback
            video.src = hlsUrl;
            video.addEventListener('loadedmetadata', () => {
              video.play();
            });
          } else {
            document.body.innerHTML = '<p>Your browser does not support HLS playback.</p>';
          }
        </script>
      </body>
    </html>
  `);
});

// All mediasoup workers
const workers: mediasoup.types.Worker[] = [];
let nextMediasoupWorkerIdx = 0;

// Room list
const roomList = new Map<string, Room>();

// Start the server
httpsServer.listen(config.listenPort, () => {
  console.log('Listening on https://localhost' + ':' + config.listenPort);
  startMediasoup();
});

async function startMediasoup(): Promise<void> {
  await createWorkers();
}

async function createWorkers(): Promise<void> {
  const { numWorkers } = config.mediasoup;

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: config.mediasoup.worker.logLevel as mediasoup.types.WorkerLogLevel,
      logTags: config.mediasoup.worker.logTags as mediasoup.types.WorkerLogTag[],
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort
    });

    worker.on('died', () => {
      console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
      setTimeout(() => process.exit(1), 2000);
    });
    
    workers.push(worker);
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', async ({ room_id }, callback) => {
    if (roomList.has(room_id)) {
      callback('already exists');
    } else {
      console.log('Created room', { room_id: room_id });
      const worker = await getMediasoupWorker();
      roomList.set(room_id, new Room(room_id, worker, io));
      callback(room_id);
    }
  });

  socket.on('join', ({ room_id, name }, callback) => {
    console.log('User joined', {
      room_id: room_id,
      name: name
    });

    if (!roomList.has(room_id)) {
      return callback({
        error: 'Room does not exist'
      });
    }

    roomList.get(room_id)!.addPeer(new Peer(socket.id, name));
    socket.room_id = room_id;

    callback(roomList.get(room_id)!.toJson());
  });

  socket.on('getProducers', () => {
    if (!socket.room_id || !roomList.has(socket.room_id)) return;
    
    const room = roomList.get(socket.room_id)!;
    const peer = room.getPeers().get(socket.id);
    
    console.log('Get producers', { name: peer?.name });

    // Send all the current producers to newly joined member
    const producerList = room.getProducerListForPeer();
    socket.emit('newProducers', producerList);
  });

  socket.on('getRouterRtpCapabilities', (_, callback) => {
    if (!socket.room_id || !roomList.has(socket.room_id)) return;
    
    const room = roomList.get(socket.room_id)!;
    const peer = room.getPeers().get(socket.id);
    
    console.log('Get RouterRtpCapabilities', { name: peer?.name });

    try {
      callback(room.getRtpCapabilities());
    } catch (e: any) {
      callback({
        error: e.message
      });
    }
  });

  socket.on('createWebRtcTransport', async (_, callback) => {
    if (!socket.room_id || !roomList.has(socket.room_id)) return;
    
    const room = roomList.get(socket.room_id)!;
    const peer = room.getPeers().get(socket.id);
    
    console.log('Create webrtc transport', { name: peer?.name });

    try {
      const { params } = await room.createWebRtcTransport(socket.id);
      callback(params);
    } catch (err: any) {
      console.error(err);
      callback({
        error: err.message
      });
    }
  });

  socket.on('connectTransport', async ({ transport_id, dtlsParameters }, callback) => {
    if (!socket.room_id || !roomList.has(socket.room_id)) return;
    
    const room = roomList.get(socket.room_id)!;
    const peer = room.getPeers().get(socket.id);
    
    console.log('Connect transport', { name: peer?.name });

    await room.connectPeerTransport(socket.id, transport_id, dtlsParameters);
    callback('success');
  });

  socket.on('produce', async ({ kind, rtpParameters, producerTransportId }, callback) => {
    if (!socket.room_id || !roomList.has(socket.room_id)) {
      return callback({ error: 'not in a room' });
    }

    const room = roomList.get(socket.room_id)!;
    const producer_id = await room.produce(
      socket.id, 
      producerTransportId, 
      rtpParameters, 
      kind as mediasoup.types.MediaKind
    );

    console.log('Produce', {
      type: kind,
      name: room.getPeers().get(socket.id)?.name,
      id: producer_id
    });

    // Get all video producers in the room
    const videoProducers = new Map<string, mediasoup.types.Producer>();
    room.getPeers().forEach(peer => {
      peer.producers.forEach((producer, id) => {
        if (producer.kind === 'video') {
          videoProducers.set(id, producer);
        }
      });
    });

    // Update HLS stream with all current producers
    if (videoProducers.size > 0) {
      const roomProducers = room.getAllProducers(); // Make sure this returns actual producer objects
      const hlsUrl = await hlsManager.updateRoomStream(socket.room_id, room.router, [...roomProducers.values()]);
      // Broadcast HLS URL to all clients in the room
      room.broadCast(socket.id, 'hlsUrl', { url: hlsUrl });
    }

    callback({ producer_id });
  });

  socket.on('consume', async ({ consumerTransportId, producerId, rtpCapabilities }, callback) => {
    if (!socket.room_id || !roomList.has(socket.room_id)) return;
    
    const room = roomList.get(socket.room_id)!;
    const params = await room.consume(socket.id, consumerTransportId, producerId, rtpCapabilities);

    console.log('Consuming', {
      name: room.getPeers().get(socket.id)?.name,
      producer_id: producerId,
      consumer_id: params?.id
    });

    callback(params);
  });

  socket.on('resume', async (data, callback) => {
    // This needs to be fixed - consumer is not defined in this scope
    // await consumer.resume();
    callback();
  });

  socket.on('getMyRoomInfo', (_, callback) => {
    if (!socket.room_id || !roomList.has(socket.room_id)) return;
    
    callback(roomList.get(socket.room_id)!.toJson());
  });

  socket.on('disconnect', async () => {
    if (!socket.room_id || !roomList.has(socket.room_id)) return;
    
    console.log('Disconnect', {
      name: roomList.get(socket.room_id)?.getPeers().get(socket.id)?.name
    });

    roomList.get(socket.room_id)!.removePeer(socket.id);
    
    // Update HLS stream after peer left
    const room = roomList.get(socket.room_id)!;
    if (room.getPeers().size > 0) {
      const videoProducers = new Map<string, mediasoup.types.Producer>();
      room.getPeers().forEach(peer => {
        peer.producers.forEach((producer, id) => {
          if (producer.kind === 'video') {
            videoProducers.set(id, producer);
          }
        });
      });
      
      if (videoProducers.size > 0) {
        const roomProducers = room.getAllProducers(); // Make sure this returns actual producer objects
        await hlsManager.updateRoomStream(socket.room_id, room.router, [...roomProducers.values()]);
      } else {
        hlsManager.stopRoomHlsStream(socket.room_id);
      }
    } else {
      // Last person left, stop HLS
      hlsManager.stopRoomHlsStream(socket.room_id);
    }
  });

  socket.on('producerClosed', ({ producer_id }) => {
    if (!socket.room_id || !roomList.has(socket.room_id)) return;
    
    console.log('Producer close', {
      name: roomList.get(socket.room_id)?.getPeers().get(socket.id)?.name
    });

    roomList.get(socket.room_id)!.closeProducer(socket.id, producer_id);
  });

    // Add this socket handler inside the connection event:
  
   socket.on('getHlsUrl', (data, callback) => {
    const roomId = data.room_id || socket.room_id;
    console.log(`Client requesting HLS URL for room: ${roomId}`);
    
    if (!roomId || !roomList.has(roomId)) {
        console.log(`Room ${roomId} not found`);
        callback({ error: 'Room not found' });
        return;
    }
    
    // Get all video producers in the room
    const room = roomList.get(roomId)!;
    const videoProducers = new Map<string, mediasoup.types.Producer>();
    room.getPeers().forEach(peer => {
        peer.producers.forEach((producer, id) => {
            if (producer.kind === 'video') {
                videoProducers.set(id, producer);
            }
        });
    });
    
    // If there are no video producers yet, just return the URL
    // the stream will start when a producer joins
    const hlsUrl = hlsManager.getHlsUrl(roomId);
      console.log(`Returning HLS URL for room ${roomId}: ${hlsUrl}`);
      
      // If we have video producers but no active stream yet, start one
      if (videoProducers.size > 0 && !hlsManager.isStreamActive(roomId)) {
          console.log(`Starting HLS stream for room ${roomId} with ${videoProducers.size} video producers`);
          hlsManager.createRoomHlsStream(roomId, room.router, room.getAllProducers())
              .then(newHlsUrl => {
                  callback({ url: newHlsUrl });
              })
              .catch(err => {
                  console.error(`Error starting HLS stream: ${err}`);
                  callback({ url: hlsUrl });
              });
      } else {
          callback({ url: hlsUrl });
      }
  });

  socket.on('exitRoom', async (_, callback) => {
    if (!socket.room_id || !roomList.has(socket.room_id)) {
      callback({
        error: 'not currently in a room'
      });
      return;
    }
    
    console.log('Exit room', {
      name: roomList.get(socket.room_id)?.getPeers().get(socket.id)?.name
    });

    // Close transports
    await roomList.get(socket.room_id)!.removePeer(socket.id);
    
    // Update HLS stream after peer left or stop if room is empty
    if (roomList.has(socket.room_id)) {
      const room = roomList.get(socket.room_id)!;
      if (room.getPeers().size > 0) {
        // Update stream with remaining peers
        const videoProducers = new Map<string, mediasoup.types.Producer>();
        room.getPeers().forEach(peer => {
          peer.producers.forEach((producer, id) => {
            if (producer.kind === 'video') {
              videoProducers.set(id, producer);
            }
          });
        });
        
        if (videoProducers.size > 0) {
          const roomProducers = room.getAllProducers(); // Make sure this returns actual producer objects
          await hlsManager.updateRoomStream(socket.room_id, room.router, [...roomProducers.values()]);
        } else {
          hlsManager.stopRoomHlsStream(socket.room_id);
        }
      } else {
        // Last person left, stop HLS and remove room
        hlsManager.stopRoomHlsStream(socket.room_id);
        roomList.delete(socket.room_id);
      }
    }
    
    const oldRoomId = socket.room_id;
    socket.room_id = undefined;
    callback('successfully exited room');
  });
});

/**
 * Get next mediasoup Worker.
 */
function getMediasoupWorker(): mediasoup.types.Worker {
  const worker = workers[nextMediasoupWorkerIdx];

  if (++nextMediasoupWorkerIdx === workers.length) nextMediasoupWorkerIdx = 0;

  return worker;
}

// Add a custom property to the Socket interface
declare module 'socket.io' {
  interface Socket {
    room_id?: string;
  }
}