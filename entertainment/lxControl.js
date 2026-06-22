class LXMusicController {
    constructor() {
        this.apiBaseUrl = 'http://127.0.0.1:23330';
        this.connected = false;
        this.statusInterval = null;
        this.eventSource = null; // For SSE
        this.statusCache = {
            progress: 0,
            duration: 1,
            name: 'No track',
            singer: 'Unknown Artist',
            albumName: 'Unknown Album',
            lyricLineText: 'No lyrics',
            status: 'stoped'
        };
        
        this.initUI();
        this.bindEvents();
    }
    
    initUI() {
        // Create LX Music container
        this.container = document.createElement('div');
        this.container.className = 'lx-music-container';
        this.container.style.cssText = `
            position: absolute;
            top: 40px;
            right: 290px;
            width: 250px;
            max-height: calc(100vh - 80px);
            background: var(--glass-bg);
            border: 1px solid var(--glass-border);
            border-radius: 10px;
            padding: 15px;
            backdrop-filter: blur(10px);
            z-index: 20;
            overflow-y: auto;
            display: none;
        `;
        
        this.container.innerHTML = `
            <div class="lx-music-header" style="font-size: 1rem; margin-bottom: 10px; color: var(--accent-purple); text-align: center;">
                LX Music
            </div>
            <div class="api-controls" style="margin-bottom: 15px;">
                <input type="text" id="lx-music-api-url" placeholder="API URL (e.g. http://127.0.0.1:23330)" 
                    style="width: 100%; padding: 8px; background: rgba(0,0,0,0.2); border: 1px solid var(--glass-border); 
                    color: white; border-radius: 4px;"/>
                <button id="connect-lx-music" style="width: 100%; margin-top: 10px; background: var(--glass-bg); 
                    border: 1px solid var(--glass-border); color: var(--accent-cyan); padding: 8px; border-radius: 4px; 
                    cursor: pointer;">Connect</button>
            </div>
            <div class="current-track-info" id="lx-current-track" style="margin-bottom: 15px; padding: 10px; 
                background: rgba(0,0,0,0.2); border-radius: 5px;">
                <div id="lx-track-name" style="color: var(--accent-cyan); font-size: 0.9rem; margin-bottom: 5px;">No track</div>
                <div id="lx-artist" style="color: rgba(255,255,255,0.7); font-size: 0.8rem; margin-bottom: 5px;">Artist</div>
                <div id="lx-album" style="color: rgba(255,255,255,0.5); font-size: 0.7rem; margin-bottom: 10px;">Album</div>
                <div id="lx-progress" style="color: rgba(255,255,255,0.7); font-size: 0.7rem;">00:00 / 00:00</div>
            </div>
            <div class="current-lyric" id="lx-current-lyric" style="min-height: 60px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 5px; color: rgba(255,255,255,0.8); font-size: 0.8rem; margin-bottom: 10px;"></div>
            <div class="controls" style="display: flex; justify-content: space-between;">
                <button id="lx-prev" style="flex: 1; margin-right: 5px; background: var(--glass-bg); border: 1px solid var(--glass-border); color: white; padding: 8px; border-radius: 4px; cursor: pointer;">Prev</button>
                <button id="lx-play-pause" style="flex: 1; margin: 0 5px; background: var(--glass-bg); border: 1px solid var(--glass-border); color: white; padding: 8px; border-radius: 4px; cursor: pointer;">Play</button>
                <button id="lx-next" style="flex: 1; margin-left: 5px; background: var(--glass-bg); border: 1px solid var(--glass-border); color: white; padding: 8px; border-radius: 4px; cursor: pointer;">Next</button>
            </div>
            <div style="margin-top: 10px;">
                <button id="disconnect-lx-music" style="width: 100%; background: var(--glass-bg); 
                    border: 1px solid var(--glass-border); color: #ff6b6b; padding: 8px; border-radius: 4px; 
                    cursor: pointer;">Disconnect</button>
            </div>
            <div style="margin-top: 10px;">
                <div class="lx-playlist-header" style="font-size: 0.9rem; margin-bottom: 10px; color: var(--accent-purple); text-align: center;">
                    Current Track
                </div>
                <div id="lx-playlist" class="lx-playlist" style="max-height: 150px; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 5px; padding: 5px;">
                    <div class="lx-playlist-item current" style="padding: 5px; color: var(--accent-cyan); cursor: pointer; border-radius: 3px;">
                        <span id="lx-current-playlist-item">No track</span>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(this.container);
        
        // Store references to UI elements
        this.apiUrlInput = document.getElementById('lx-music-api-url');
        this.connectBtn = document.getElementById('connect-lx-music');
        this.disconnectBtn = document.getElementById('disconnect-lx-music');
        this.currentTrack = document.getElementById('lx-current-track');
        this.trackName = document.getElementById('lx-track-name');
        this.artist = document.getElementById('lx-artist');
        this.album = document.getElementById('lx-album');
        this.progress = document.getElementById('lx-progress');
        this.currentLyric = document.getElementById('lx-current-lyric');
        this.prevBtn = document.getElementById('lx-prev');
        this.playPauseBtn = document.getElementById('lx-play-pause');
        this.nextBtn = document.getElementById('lx-next');
        this.currentPlaylistItem = document.getElementById('lx-current-playlist-item');
        
        // Set default API URL
        this.apiUrlInput.value = this.apiBaseUrl;
        
        // Add click event to document to close panel when clicking outside
        document.addEventListener('click', (event) => {
            if (!this.container.contains(event.target) && 
                !event.target.classList.contains('lx-music-toggle')) {
                this.container.style.display = 'none';
            }
        });
    }
    
    bindEvents() {
        // Connect button
        this.connectBtn.addEventListener('click', () => {
            this.apiBaseUrl = this.apiUrlInput.value || 'http://127.0.0.1:23330';
            this.connect();
        });
        
        // Disconnect button
        this.disconnectBtn.addEventListener('click', () => {
            this.disconnect();
            this.connectBtn.textContent = 'Connect';
            this.connectBtn.style.color = 'var(--accent-cyan)';
        });
        
        // Control buttons - using correct API endpoints
        this.prevBtn.addEventListener('click', () => {
            if (this.connected) {
                this.sendCommand('/skip-prev');
            }
        });
        
        this.playPauseBtn.addEventListener('click', () => {
            if (this.connected) {
                this.sendCommand('/pause');
            }
        });
        
        this.nextBtn.addEventListener('click', () => {
            if (this.connected) {
                this.sendCommand('/skip-next');
            }
        });
        
        // Click on current playlist item to play the track
        this.currentPlaylistItem.addEventListener('click', () => {
            if (this.connected) {
                // Since we only have one item in the playlist (current track), just ensure it's playing
                this.sendCommand('/play');
            }
        });
    }
    
    async connect() {
        try {
            // Test connection
            const response = await fetch(`${this.apiBaseUrl}/status`);
            if (response.ok) {
                this.connected = true;
                this.connectBtn.textContent = 'Connected';
                this.connectBtn.style.color = 'lightgreen';
                
                // Get initial status to update UI correctly
                const statusResponse = await fetch(`${this.apiBaseUrl}/status`);
                if (statusResponse.ok) {
                    const statusData = await statusResponse.json();
                    // Update status cache with initial data
                    this.statusCache.status = statusData.status || 'unknown';
                    this.statusCache.name = statusData.name || 'Unknown';
                    this.statusCache.singer = statusData.singer || 'Unknown';
                    this.statusCache.albumName = statusData.albumName || 'Unknown';
                    this.statusCache.duration = statusData.duration || 0;
                    this.statusCache.progress = statusData.progress || 0;
                    this.statusCache.lyricLineText = statusData.lyricLineText || '';
                    
                    // Update UI to reflect current state
                    this.updateUI();
                }
                
                // Start using SSE for real-time status updates
                this.startSSE();
            } else {
                throw new Error('Connection failed');
            }
        } catch (error) {
            this.connected = false;
            this.connectBtn.textContent = 'Connect';
            this.connectBtn.style.color = 'var(--accent-cyan)';
            console.error('LX Music connection error:', error);
        }
    }
    
    startSSE() {
        // Close any existing SSE connection
        if (this.eventSource) {
            this.eventSource.close();
        }
        
        // Create new SSE connection
        const sseUrl = `${this.apiBaseUrl}/subscribe-player-status`;
        this.eventSource = new EventSource(sseUrl);
        
        // Handle different types of events
        this.eventSource.addEventListener('status', (event) => {
            this.statusCache.status = event.data;
            this.updateUI();
            this.updatePlaylist(); // Update playlist when status changes
        });
        
        this.eventSource.addEventListener('name', (event) => {
            this.statusCache.name = event.data;
            this.updateUI();
            this.updatePlaylist(); // Update playlist when track name changes
        });
        
        this.eventSource.addEventListener('singer', (event) => {
            this.statusCache.singer = event.data;
            this.updateUI();
            this.updatePlaylist(); // Update playlist when singer changes
        });
        
        this.eventSource.addEventListener('albumName', (event) => {
            this.statusCache.albumName = event.data;
            this.updateUI();
        });
        
        this.eventSource.addEventListener('duration', (event) => {
            this.statusCache.duration = parseFloat(event.data);
            this.updateUI();
        });
        
        this.eventSource.addEventListener('progress', (event) => {
            this.statusCache.progress = parseFloat(event.data);
            this.updateUI();
        });
        
        this.eventSource.addEventListener('lyricLineText', (event) => {
            this.statusCache.lyricLineText = event.data;
            this.updateUI();
        });
        
        // Handle errors
        this.eventSource.onerror = () => {
            console.error('SSE connection error');
            this.eventSource.close();
            this.eventSource = null;
        };
    }
    
    // Method to integrate with main playlist
    integrateWithPlaylist(playlistController) {
        this.playlistController = playlistController;
        
        // Add event listeners to playlist items for LX Music
        if (this.isConnected()) {
            // Update playlist when LX Music status changes
            this.updatePlaylist();
        }
    }
    
    updatePlaylist() {
        // Update the playlist display with the current track
        const trackDisplay = `${this.statusCache.name} - ${this.statusCache.singer}`;
        if (this.currentPlaylistItem) {
            this.currentPlaylistItem.textContent = trackDisplay;
        }
        
        // If we have a reference to the playlist controller, update it
        if (this.playlistController) {
            this.playlistController.renderPlaylist();
        }
    }
    
    updateUI() {
        // Update track info
        this.trackName.textContent = this.statusCache.name;
        this.artist.textContent = this.statusCache.singer;
        this.album.textContent = this.statusCache.albumName;
        
        // Format time
        const progressFormatted = this.formatTime(this.statusCache.progress);
        const durationFormatted = this.formatTime(this.statusCache.duration);
        this.progress.textContent = `${progressFormatted} / ${durationFormatted}`;
        
        // Update lyric
        this.currentLyric.textContent = this.statusCache.lyricLineText;
        
        // Update play/pause button
        this.playPauseBtn.textContent = this.statusCache.status === 'playing' ? 'Pause' : 'Play';
    }
    
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }
    
    async sendCommand(endpoint) {
        if (!this.connected) {
            console.warn('LX Music not connected');
            return;
        }
        
        try {
            let url;
            let options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            };
            
            // Determine the correct URL based on the endpoint
            if (endpoint.startsWith('/')) {
                url = `${this.apiBaseUrl}${endpoint}`;
            } else {
                // Map command names to their corresponding endpoints
                switch(endpoint) {
                    case 'prev':
                        url = `${this.apiBaseUrl}/skip-prev`;
                        break;
                    case 'next':
                        url = `${this.apiBaseUrl}/skip-next`;
                        break;
                    case 'play-pause':
                        url = `${this.apiBaseUrl}/pause`;
                        break;
                    default:
                        url = `${this.apiBaseUrl}/${endpoint}`;
                }
            }
            
            const response = await fetch(url, options);
            
            if (!response.ok) {
                throw new Error(`Command failed with status ${response.status}`);
            }
            
            // For pause command, we need to update the UI immediately to provide feedback
            // Since /pause toggles the state, we should update the button text to reflect the expected new state
            if (endpoint === '/pause' || endpoint === 'play-pause') {
                // Immediately update the button text to show the expected new state
                // (the actual state will be updated by SSE when it receives the new status)
                const isCurrentlyPlaying = this.statusCache.status === 'playing';
                this.playPauseBtn.textContent = isCurrentlyPlaying ? 'Play' : 'Pause';
            }
        } catch (error) {
            console.error(`Error sending command to LX Music:`, error);
            // Don't show alert for command errors, just log them to console
        }
    }
    
    // Method to get real-time audio data from LX Music
    async getAudioData() {
        if (!this.connected) {
            throw new Error('LX Music not connected');
        }
        
        try {
            // Try to fetch real-time audio spectrum data from LX Music
            const response = await fetch(`${this.apiBaseUrl}/audio/spectrum`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                return data.spectrum || [];
            } else {
                // If the spectrum endpoint doesn't exist or doesn't return data, 
                // we'll try to get the equalizer bands data
                const eqResponse = await fetch(`${this.apiBaseUrl}/equalizer/bands`, {
                    method: 'GET'
                });
                
                if (eqResponse.ok) {
                    const eqData = await eqResponse.json();
                    // Convert equalizer bands to frequency data format
                    if (eqData && Array.isArray(eqData.bands)) {
                        // Normalize the equalizer bands to fit in the 0-255 range
                        return eqData.bands.map(band => Math.min(255, Math.max(0, Math.floor(band * 30))));
                    }
                }
                
                // If neither endpoint works, return null to trigger fallback
                return null;
            }
        } catch (error) {
            console.error('Error fetching LX Music audio data:', error);
            return null;
        }
    }
    
    getStatusCache() {
        return this.statusCache;
    }
    
    isConnected() {
        return this.connected;
    }
    
    disconnect() {
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = null;
        }
        
        // Close SSE connection if exists
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        
        this.connected = false;
        
        // Reset UI
        this.connectBtn.textContent = 'Connect';
        this.connectBtn.style.color = 'var(--accent-cyan)';
        
        // Reset track info
        this.statusCache = {
            progress: 0,
            duration: 1,
            name: 'No track',
            singer: 'Unknown Artist',
            albumName: 'Unknown Album',
            lyricLineText: 'No lyrics',
            status: 'stoped'
        };
        
        this.updateUI();
    }
    
    // Method to cleanup resources when switching to another audio source
    cleanup() {
        this.disconnect();
    }
}

// Export for use in other modules (if using modules) or create global instance
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LXMusicController;
}
