class PlaylistController {
    constructor(audioElement, audioContext, analyser, threeDScene, lxMusicController) {
        this.audioElement = audioElement;
        this.audioContext = audioContext;
        this.analyser = analyser;
        this.threeDScene = threeDScene;
        this.lxMusicController = lxMusicController;
        this.tracks = [];
        this.currentTrackIndex = -1;
        this.dataArray = null;
        this.isAudioInit = false;
        
        this.initElements();
        this.bindEvents();
    }
    
    initElements() {
        this.playlistContainer = document.getElementById('playlist-container');
        this.playlistToggle = document.getElementById('playlist-toggle');
        this.playlist = document.getElementById('playlist');
        this.trackNameElement = document.getElementById('track-name');
        this.inputElement = document.getElementById('audio-input');
    }
    
    bindEvents() {
        // Toggle playlist visibility
        this.playlistToggle.addEventListener('click', () => {
            if (this.playlistContainer.style.display === 'none') {
                this.playlistContainer.style.display = 'block';
            } else {
                this.playlistContainer.style.display = 'none';
            }
        });
        
        // Input file change event
        this.inputElement.addEventListener('change', (e) => {
            // Initialize audio context on user interaction
            this.initAudioContext();
            
            const selectedFiles = e.target.files;
            if (!selectedFiles || selectedFiles.length === 0) return;

            // Add new tracks to the list
            for (let i = 0; i < selectedFiles.length; i++) {
                const file = selectedFiles[i];
                // Check if file is already in the list
                const existingIndex = this.tracks.findIndex(track => track.name === file.name && track.size === file.size);
                
                if (existingIndex === -1) { // Add only if not already in the list
                    this.tracks.push(file);
                }
            }
            
            // Update playlist display
            this.renderPlaylist();
            
            // Play the first track if none is playing
            if (this.currentTrackIndex === -1) {
                this.currentTrackIndex = 0;
                this.playTrack(this.currentTrackIndex);
            }
        });
        
        // Close playlist when clicking outside
        document.addEventListener('click', (e) => {
            if (!this.playlistContainer.contains(e.target) && 
                e.target !== this.playlistToggle && 
                this.playlistContainer.style.display === 'block' &&
                !document.querySelector('.lx-music-container').contains(e.target) && 
                e.target !== document.querySelector('.lx-music-toggle')) {
                this.playlistContainer.style.display = 'none';
            }
        });
    }
    
    initAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256; // Smaller FFT size is enough for visualizer bars
            this.analyser.smoothingTimeConstant = 0.8; 

            const source = this.audioContext.createMediaElementSource(this.audioElement);
            source.connect(this.analyser);
            this.analyser.connect(this.audioContext.destination);
            
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
            this.isAudioInit = true;
            
            // Initialize the 3D scene with audio context
            this.threeDScene.initAudio(this.analyser, this.dataArray);
        }
    }
    
    renderPlaylist() {
        // Clear the playlist
        this.playlist.innerHTML = '';
        
        // Add tracks to the playlist
        this.tracks.forEach((track, index) => {
            const li = document.createElement('li');
            li.textContent = track.name;
            li.classList.add('playlist-item');
            
            // Highlight the current playing track
            if (index === this.currentTrackIndex) {
                li.classList.add('active');
            }
            
            // Add click event to play the track
            li.addEventListener('click', () => {
                this.playTrack(index);
            });
            
            this.playlist.appendChild(li);
        });
        
        // Add LX Music track to the playlist if connected
        if (this.lxMusicController && this.lxMusicController.isConnected()) {
            const statusCache = this.lxMusicController.getStatusCache();
            const lxTrackName = `${statusCache.name} - ${statusCache.singer}`;
            
            const li = document.createElement('li');
            li.textContent = lxTrackName;
            li.classList.add('playlist-item', 'lx-music-item');
            
            // LX Music item is always considered active when LX Music is connected
            if (this.lxMusicController.isConnected()) {
                li.classList.add('active');
            }
            
            // Add click event to play LX Music
            li.addEventListener('click', () => {
                // For LX Music, we just ensure it's connected and playing
                if (this.lxMusicController.isConnected()) {
                    this.lxMusicController.sendCommand('/play');
                }
            });
            
            this.playlist.appendChild(li);
        }
    }
    
    playTrack(index) {
        // Check if we're trying to play the LX Music track
        if (this.lxMusicController && this.lxMusicController.isConnected() && index === this.tracks.length) {
            // If it's the LX Music track, just make sure it's playing
            this.lxMusicController.sendCommand('/play');
            this.trackNameElement.textContent = `${this.lxMusicController.statusCache.name} - ${this.lxMusicController.statusCache.singer}`;
            this.currentTrackIndex = index;
            this.renderPlaylist();
            return;
        }
        
        // For local tracks
        if (index < 0 || index >= this.tracks.length) return;
        
        const track = this.tracks[index];
        
        // Create object URL for the track
        const url = URL.createObjectURL(track);
        
        // Set the source and play
        this.audioElement.src = url;
        this.audioElement.play().catch(e => console.error("Error playing track:", e));
        
        // Update current track index
        this.currentTrackIndex = index;
        
        // Update the track name display
        this.trackNameElement.textContent = track.name;
        
        // Update playlist UI
        this.renderPlaylist();
    }
    
    // Getters
    getTracks() {
        return this.tracks;
    }
    
    getCurrentTrackIndex() {
        return this.currentTrackIndex;
    }
    
    getPlaylistContainer() {
        return this.playlistContainer;
    }
    
    getPlaylistToggle() {
        return this.playlistToggle;
    }
}

// Export for use in other modules (if using modules) or create global instance
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlaylistController;
}