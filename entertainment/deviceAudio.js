class SystemAudioController {
    constructor(audioContext, analyser, tracks, renderPlaylist, updateUI, playTrack) {
        this.audioContext = audioContext;
        this.analyser = analyser;
        this.tracks = tracks;
        this.renderPlaylist = renderPlaylist;
        this.updateUI = updateUI;
        this.playTrack = playTrack;
        this.currentSource = null;
        this.systemAudioTrack = null;
        
        this.initUI();
        this.bindEvents();
    }
    
    initUI() {
        // Get system audio button through its label's click event
        const systemAudioLabel = document.getElementById('system-audio-label');
        
        systemAudioLabel.addEventListener('click', (e) => {
            const systemAudioBtn = document.getElementById('system-audio-btn');
            if (systemAudioBtn && !e.target.closest('input')) {
                e.preventDefault();
                systemAudioBtn.click();
            }
        });
    }
    
    bindEvents() {
        // Get system audio button
        const systemAudioBtn = document.getElementById('system-audio-btn');
        
        // System audio button event listener
        systemAudioBtn.addEventListener('click', async () => {
            try {
                // Initialize audio context on user interaction
                if (!this.audioContext) {
                    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    this.analyser = this.audioContext.createAnalyser();
                    this.analyser.fftSize = 256;
                    this.analyser.smoothingTimeConstant = 0.8;
                }
                
                // Request screen capture with audio
                const stream = await navigator.mediaDevices.getDisplayMedia({
                    video: true, // Required for audio capture in some browsers
                    audio: true
                });
                
                // Get the audio track from the stream
                const audioTracks = stream.getAudioTracks();
                
                if (audioTracks.length > 0) {
                    this.systemAudioTrack = audioTracks[0];
                    
                    // Create a new media stream with just the audio track
                    const audioStream = new MediaStream([this.systemAudioTrack]);
                    
                    // Add to playlist as "System Audio"
                    const systemFile = {
                        name: "System Audio",
                        size: 0,
                        type: "system/audio",
                        isSystemAudio: true,
                        stream: audioStream
                    };
                    
                    // Find if system audio is already in the tracks list
                    const existingIndex = this.tracks.findIndex(track => track.name === "System Audio");
                    
                    if (existingIndex !== -1) {
                        // If it exists, just play it
                        this.playTrack(existingIndex);
                    } else {
                        // Add to the tracks array
                        this.tracks.push(systemFile);
                        
                        // Update UI
                        this.updateUI("System Audio");
                        
                        // Update playlist display
                        this.renderPlaylist();
                        
                        // Play the system audio track
                        this.playTrack(this.tracks.length - 1);
                    }
                    
                    // Stop all tracks in the original stream to prevent multiple capture
                    stream.getVideoTracks().forEach(track => track.stop());
                    
                    console.log("System audio capture started");
                } else {
                    alert("No audio tracks found in the captured stream");
                }
            } catch (err) {
                console.error("Error capturing system audio:", err);
                alert("Failed to capture system audio: " + err.message);
            }
        });
    }
    
    // Method to start system audio capture
    async startSystemAudio() {
        try {
            // Request screen capture with audio
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: true, // Required for audio capture in some browsers
                audio: true
            });
            
            // Get the audio track from the stream
            const audioTracks = stream.getAudioTracks();
            
            if (audioTracks.length > 0) {
                this.systemAudioTrack = audioTracks[0];
                
                // Create a new media stream with just the audio track
                const audioStream = new MediaStream([this.systemAudioTrack]);
                
                // Create an audio source for the stream
                if (this.currentSource) {
                    this.currentSource.disconnect();
                }
                
                const audioSource = this.audioContext.createMediaStreamSource(audioStream);
                audioSource.connect(this.analyser);
                this.currentSource = audioSource;
                
                // Add to playlist as "System Audio"
                const systemFile = {
                    name: "System Audio",
                    size: 0,
                    type: "system/audio",
                    isSystemAudio: true,
                    stream: audioStream
                };
                
                // Clear existing tracks and add system audio
                this.tracks = [systemFile];
                this.currentTrackIndex = 0;
                
                // Update UI
                this.onTrackChange("System Audio");
                
                // Update playlist display
                this.renderPlaylist();
                
                // Stop all tracks in the original stream to prevent multiple capture
                stream.getVideoTracks().forEach(track => track.stop());
                
                console.log("System audio capture started");
            } else {
                alert("No audio tracks found in the captured stream");
            }
        } catch (err) {
            console.error("Error capturing system audio:", err);
            alert("Failed to capture system audio: " + err.message);
        }
    }
    
    // Method to stop system audio capture
    stopSystemAudio() {
        if (this.currentSource) {
            this.currentSource.disconnect();
            this.currentSource = null;
        }
        
        if (this.systemAudioTrack) {
            this.systemAudioTrack.stop();
            this.systemAudioTrack = null;
        }
        
        // Remove system audio from tracks
        this.tracks = this.tracks.filter(track => !track.isSystemAudio);
        this.currentTrackIndex = -1;
        
        // Update UI
        this.onTrackChange("NO DATA");
        
        // Update playlist display
        this.renderPlaylist();
        
        console.log("System audio capture stopped");
    }
    
    // Method to set current source
    setCurrentSource(source) {
        if (this.currentSource) {
            this.currentSource.disconnect();
        }
        this.currentSource = source;
    }
    
    getCurrentSource() {
        return this.currentSource;
    }
    
    getSystemAudioTrack() {
        return this.systemAudioTrack;
    }
}

// Export for use in other modules (if using modules) or create global instance
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SystemAudioController;
}