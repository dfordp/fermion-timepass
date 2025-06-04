// Function to get URL parameters
function getUrlParameter(name) {
    name = name.replace(/[\[]/, '\\[').replace(/[\]]/, '\\]');
    const regex = new RegExp('[\\?&]' + name + '=([^&#]*)');
    const results = regex.exec(location.search);
    return results === null ? '' : decodeURIComponent(results[1].replace(/\+/g, ' '));
}

// Get the user role from URL parameter
const userRole = getUrlParameter('role');
let hlsPlayer = null;

// Function to handle UI based on user role
function setupUIForRole() {
    console.log(`Setting up UI for role: ${userRole}`);
    
    if (userRole === 'watcher') {
        // Hide all producer controls for watchers
        const elementsToHide = [
            'startAudioButton', 'stopAudioButton',
            'startVideoButton', 'stopVideoButton',
            'startScreenButton', 'stopScreenButton',
            'devicesButton', 'devicesList'
        ];
        
        elementsToHide.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.style.display = 'none';
            }
        });
        
        // Create HLS player container if it doesn't exist
        if (!document.getElementById('hlsPlayerContainer')) {
            const hlsContainer = document.createElement('div');
            hlsContainer.id = 'hlsPlayerContainer';
            hlsContainer.className = 'hls-container';
            
            const hlsHeader = document.createElement('h4');
            hlsHeader.innerHTML = '<i class="fab fa-youtube"></i> Live Stream';
            
            const hlsVideo = document.createElement('video');
            hlsVideo.id = 'hlsVideo';
            hlsVideo.className = 'vid';
            hlsVideo.controls = true;
            hlsVideo.autoplay = true;
            hlsVideo.playsInline = true;
            
            const statusDiv = document.createElement('div');
            statusDiv.id = 'hlsStatus';
            statusDiv.textContent = 'Waiting for stream...';
            statusDiv.style.padding = '10px';
            statusDiv.style.backgroundColor = '#f8f9fa';
            statusDiv.style.borderRadius = '4px';
            statusDiv.style.margin = '10px 0';
            
            hlsContainer.appendChild(hlsHeader);
            hlsContainer.appendChild(hlsVideo);
            hlsContainer.appendChild(statusDiv);
            
            // Add the HLS container to the page
            const videoMedia = document.getElementById('videoMedia');
            if (videoMedia) {
                videoMedia.insertBefore(hlsContainer, videoMedia.firstChild);
            }
        }
        
        console.log("Watcher mode enabled - media controls hidden, HLS player added");
    } else {
        console.log("Streamer mode enabled - full controls available");
    }
}

if (location.href.substr(0, 5) !== 'https') location.href = 'https' + location.href.substr(4, location.href.length - 4)

const socket = io()

let producer = null

nameInput.value = 'user_' + Math.round(Math.random() * 1000)

socket.request = function request(type, data = {}) {
  return new Promise((resolve, reject) => {
    socket.emit(type, data, (data) => {
      if (data.error) {
        reject(data.error)
      } else {
        resolve(data)
      }
    })
  })
}

let rc = null

function joinRoom(name, room_id) {
    if (rc && rc.isOpen()) {
        console.log('Already connected to a room');
    } else {
        // Only initialize devices for non-watchers to avoid permission prompts
        if (userRole !== 'watcher') {
            initEnumerateDevices();
        }
        
        // Create room client - for watchers, we still need to join the room to get the HLS URL
        rc = new RoomClient(localMedia, remoteVideos, remoteAudios, window.mediasoupClient, socket, room_id, name, roomOpen);
        
        addListeners();
        
        // Apply role after joining room
        setTimeout(setupUIForRole, 500);
        
        // Listen for HLS URL from the server
        socket.on('hlsUrl', (data) => {
            console.log('Received HLS URL event:', data);
            if (userRole === 'watcher' && data.url) {
                startHlsPlayer(data.url);
            }
        });
        
        // For watchers, also manually request the HLS URL after joining
        if (userRole === 'watcher') {
            console.log('Watcher joining, will request HLS URL');
            
            // Ask for HLS URL 2 seconds after joining
            setTimeout(() => {
                console.log('Requesting HLS URL for room:', room_id);
                socket.emit('getHlsUrl', { room_id }, (response) => {
                    console.log('HLS URL response:', response);
                    if (response && response.url) {
                        startHlsPlayer(response.url);
                    } else {
                        console.error('No HLS URL in response:', response);
                        const statusEl = document.getElementById('hlsStatus');
                        if (statusEl) {
                            statusEl.textContent = 'Stream not available yet. Please wait...';
                        }
                    }
                });
            }, 2000);
        }
    }
}

// Function to start the HLS player
function startHlsPlayer(hlsUrl) {
    console.log('Starting HLS player with URL:', hlsUrl);
    
    // Check if HLS container exists, if not create it
    let videoElement = document.getElementById('hlsVideo');
    if (!videoElement) {
        console.log('Creating new HLS video element');
        setupUIForRole(); // Recreate the UI to ensure video element exists
        videoElement = document.getElementById('hlsVideo');
    }
    
    if (!videoElement) {
        console.error('Failed to create or find HLS video element');
        return;
    }
    
    // Clean up existing player if any
    if (hlsPlayer) {
        console.log('Destroying existing HLS player');
        hlsPlayer.destroy();
        hlsPlayer = null;
    }
    
    // Check if URL is valid
    if (!hlsUrl || !hlsUrl.includes('.m3u8')) {
        console.error('Invalid HLS URL:', hlsUrl);
        updateStatus('Invalid stream URL. Please try again later.');
        return;
    }
    
    updateStatus('Connecting to stream...');
    
    console.log('Initializing HLS.js with URL:', hlsUrl);
    
    if (Hls.isSupported()) {
        hlsPlayer = new Hls({
            debug: false,
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 90
        });
        
        // Add event listeners
        hlsPlayer.on(Hls.Events.MEDIA_ATTACHED, function() {
            console.log('HLS.js media attached');
            updateStatus('Media attached, loading stream...');
        });
        
        hlsPlayer.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
            console.log('HLS manifest parsed, found ' + data.levels.length + ' quality levels');
            updateStatus('Stream loaded, playing...');
            videoElement.play().catch(e => {
                console.error('Failed to play:', e);
                updateStatus('Error playing stream: ' + e.message);
            });
        });
        
        hlsPlayer.on(Hls.Events.LEVEL_LOADED, function(event, data) {
            console.log('Level loaded:', data.details);
            if (data.details.live) {
                updateStatus('Live stream connected');
                setTimeout(() => {
                    const statusEl = document.getElementById('hlsStatus');
                    if (statusEl) {
                        statusEl.style.display = 'none';
                    }
                }, 3000);
            } else {
                updateStatus('Playing recorded stream');
            }
        });
        
        hlsPlayer.on(Hls.Events.ERROR, function(event, data) {
            console.error('HLS error:', data);
            
            if (data.fatal) {
                updateStatus('Stream error: ' + data.type);
                switch(data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        console.log('Fatal network error, trying to recover');
                        updateStatus('Network error, reconnecting...');
                        hlsPlayer.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        console.log('Fatal media error, trying to recover');
                        updateStatus('Media error, recovering...');
                        hlsPlayer.recoverMediaError();
                        break;
                    default:
                        console.error('Fatal error, cannot recover');
                        updateStatus('Fatal error: ' + data.details);
                        hlsPlayer.destroy();
                        // Try to reinitialize after a delay
                        setTimeout(() => startHlsPlayer(hlsUrl), 5000);
                        break;
                }
            }
        });
        
        // Try loading the stream
        try {
            hlsPlayer.loadSource(hlsUrl);
            hlsPlayer.attachMedia(videoElement);
        } catch (e) {
            console.error('Error initializing HLS player:', e);
            updateStatus('Failed to initialize player: ' + e.message);
        }
    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        // For Safari
        videoElement.src = hlsUrl;
        videoElement.addEventListener('loadedmetadata', function() {
            updateStatus('Stream loaded, playing...');
            videoElement.play().catch(e => {
                console.error('Failed to play:', e);
                updateStatus('Error playing stream: ' + e.message);
            });
        });
        
        videoElement.addEventListener('error', function(e) {
            console.error('Video element error:', e);
            updateStatus('Video error: ' + (videoElement.error ? videoElement.error.message : 'unknown'));
        });
    } else {
        console.error('HLS is not supported in this browser');
        updateStatus('Your browser does not support HLS playback.');
    }
    
    function updateStatus(message) {
        console.log('HLS Status:', message);
        const statusEl = document.getElementById('hlsStatus');
        if (statusEl) {
            statusEl.textContent = message;
        }
    }
}

function roomOpen() {
  login.className = 'hidden'
  
  // Only show media controls for non-watchers
  if (userRole !== 'watcher') {
    reveal(startAudioButton)
    hide(stopAudioButton)
    reveal(startVideoButton)
    hide(stopVideoButton)
    reveal(startScreenButton)
    hide(stopScreenButton)
    reveal(devicesButton)
  }
  
  reveal(exitButton)
  reveal(copyButton)
  control.className = ''
  reveal(videoMedia)
  
  // Apply role-based UI with a small delay after opening room
  setTimeout(setupUIForRole, 100);
}

function hide(elem) {
  elem.className = 'hidden'
}

function reveal(elem) {
  elem.className = ''
}

function addListeners() {
  rc.on(RoomClient.EVENTS.startScreen, () => {
    hide(startScreenButton)
    reveal(stopScreenButton)
  })

  rc.on(RoomClient.EVENTS.stopScreen, () => {
    hide(stopScreenButton)
    reveal(startScreenButton)
  })

  rc.on(RoomClient.EVENTS.stopAudio, () => {
    hide(stopAudioButton)
    reveal(startAudioButton)
  })
  rc.on(RoomClient.EVENTS.startAudio, () => {
    hide(startAudioButton)
    reveal(stopAudioButton)
  })

  rc.on(RoomClient.EVENTS.startVideo, () => {
    hide(startVideoButton)
    reveal(stopVideoButton)
  })
  rc.on(RoomClient.EVENTS.stopVideo, () => {
    hide(stopVideoButton)
    reveal(startVideoButton)
  })
  rc.on(RoomClient.EVENTS.exitRoom, () => {
    hide(control)
    hide(devicesList)
    hide(videoMedia)
    hide(copyButton)
    hide(devicesButton)
    reveal(login)
    
    // Clean up HLS player if it exists
    if (hlsPlayer) {
      hlsPlayer.destroy();
      hlsPlayer = null;
    }
  })
}

let isEnumerateDevices = false

function initEnumerateDevices() {
  // Many browsers, without the consent of getUserMedia, cannot enumerate the devices.
  if (isEnumerateDevices) return

  const constraints = {
    audio: true,
    video: true
  }

  navigator.mediaDevices
    .getUserMedia(constraints)
    .then((stream) => {
      enumerateDevices()
      stream.getTracks().forEach(function (track) {
        track.stop()
      })
    })
    .catch((err) => {
      console.error('Access denied for audio/video: ', err)
    })
}

function enumerateDevices() {
  // Load mediaDevice options
  navigator.mediaDevices.enumerateDevices().then((devices) =>
    devices.forEach((device) => {
      let el = null
      if ('audioinput' === device.kind) {
        el = audioSelect
      } else if ('videoinput' === device.kind) {
        el = videoSelect
      }
      if (!el) return

      let option = document.createElement('option')
      option.value = device.deviceId
      option.innerText = device.label
      el.appendChild(option)
      isEnumerateDevices = true
    })
  )
}

// Add this event listener to ensure role is applied when DOM is fully loaded
document.addEventListener('DOMContentLoaded', function() {
    console.log("DOM loaded, user role: " + userRole);
    
    // Pre-populate room ID from URL if available
    const roomIdParam = getUrlParameter('room');
    if (roomIdParam) {
        const roomInput = document.getElementById('roomidInput');
        if (roomInput) {
            roomInput.value = roomIdParam;
        }
    }
    
    // Auto-join if both room and role are specified
    if (roomIdParam && userRole) {
        const nameInput = document.getElementById('nameInput');
        const name = nameInput ? nameInput.value : 'user_' + Math.round(Math.random() * 1000);
        
        // Small delay to ensure everything is loaded
        setTimeout(() => {
            joinRoom(name, roomIdParam);
        }, 500);
    }
    
    setTimeout(setupUIForRole, 100);
});