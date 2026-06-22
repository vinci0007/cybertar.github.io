class ThreeDScene {
    constructor(containerId) {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.sphere = null;
        this.analyser = null;
        this.dataArray = null;
        this.isAudioInit = false;
        this.audioContext = null;
        this.originalPositions = null;
        this.count = 0;
        this.smoothedAvg = 0;
        this.smoothedBass = 0;
        this.time = 0;
        this.isDragging = false;
        this.targetRotationX = 0;
        this.targetRotationY = 0;
        this.previousMouseX = 0;
        this.previousMouseY = 0;
        this.lxMusicController = null;
        this.monitorCanvas = null;
        this.monitorCtx = null;
        
        this.init(containerId);
        this.setupEventListeners();
        this.initMonitor();
    }
    
    init(containerId) {
        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x030303, 0.002);

        this.camera = new THREE.PerspectiveCamera(91, window.innerWidth / window.innerHeight, 0.1, 1000);
        // 俯视角度 - 将相机放置在球体上方，并稍微向后偏移以便观察整个球体
        this.camera.position.z = 35;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        
        const container = document.getElementById(containerId);
        if (container) {
            container.appendChild(this.renderer.domElement);
        } else {
            document.body.appendChild(this.renderer.domElement);
        }

        // Particle Sphere
        const geometry = new THREE.SphereGeometry(11, 128, 128); 
        const material = new THREE.PointsMaterial({
            size: 0.15,
            color: 0xffffff,
            transparent: true,
            opacity: 0.6,
            blending: THREE.AdditiveBlending,
            vertexColors: true
        });

        this.count = geometry.attributes.position.count;
        const colors = [];
        const color1 = new THREE.Color(0x00f2ff);
        const color2 = new THREE.Color(0xbd00ff);
        this.originalPositions = geometry.attributes.position.array.slice();

        for (let i = 0; i < this.count; i++) {
            const mixed = color1.clone().lerp(color2, Math.random());
            colors.push(mixed.r, mixed.g, mixed.b);
        }
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

        this.sphere = new THREE.Points(geometry, material);
        this.scene.add(this.sphere);

        // 俯视角度需要调整球体的旋转，使其顶部朝向相机
        // 设置球体旋转，让其"顶部"朝上，符合俯视视角
        this.sphere.rotation.x = -Math.PI / 2; // Rotate -90 degrees around x-axis to point top forward
        this.sphere.rotation.y = 0;
    }
    
    initMonitor() {
        // Use existing mini-monitor canvas from footer-left
        this.monitorCanvas = document.getElementById('mini-monitor');
        if (this.monitorCanvas) {
            this.monitorCtx = this.monitorCanvas.getContext('2d');
        } else {
            console.warn('Mini monitor canvas not found');
        }
    }
    
    setupEventListeners() {
        // Mouse event handlers for rotation
        document.addEventListener('mousemove', (e) => {
            // Calculate mouse movement delta
            const deltaX = e.clientX - this.previousMouseX;
            const deltaY = e.clientY - this.previousMouseY;
            
            if (this.isDragging) {
                // Rotate sphere based on mouse drag
                this.sphere.rotation.y += deltaX * 0.005;
                this.sphere.rotation.x += deltaY * 0.005;
                
                // Update target rotation values to maintain rotation after release
                this.targetRotationY = this.sphere.rotation.y;
                this.targetRotationX = this.sphere.rotation.x;
            } else {
                // Update global mouse position for non-drag rotation effect
                this.targetRotationX = (e.clientY - window.innerHeight / 2) * 0.0005;
                this.targetRotationY = (e.clientX - window.innerWidth / 2) * 0.0005;
            }
            
            // Update previous positions
            this.previousMouseX = e.clientX;
            this.previousMouseY = e.clientY;
        });

        // Mouse down event
        document.addEventListener('mousedown', (e) => {
            this.isDragging = true;
            this.previousMouseX = e.clientX;
            this.previousMouseY = e.clientY;
        });

        // Mouse up event
        document.addEventListener('mouseup', () => {
            this.isDragging = false;
        });

        // Mouse leave window event
        document.addEventListener('mouseleave', () => {
            this.isDragging = false;
        });

        // Window resize handler
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }
    
    // Linear interpolation helper
    lerp(start, end, amt) {
        return (1 - amt) * start + amt * end;
    }
    
    // Animation loop
    animate() {
        requestAnimationFrame(() => this.animate());
        this.time += 0.005;

        // Variables for audio data
        let bassTarget = 0;
        let avgTarget = 0;

        if (this.isAudioInit && this.analyser && !(this.lxMusicController && this.lxMusicController.isConnected())) {
            this.analyser.getByteFrequencyData(this.dataArray);
            
            // Process data for 3D Sphere
            const overallSum = this.dataArray.reduce((a, b) => a + b, 0);
            avgTarget = overallSum / this.dataArray.length;
            bassTarget = this.dataArray[5] / 255; // Low frequency index

            // Draw Mini Monitor (Right Bottom Corner)
            this.drawMonitor(this.dataArray);
        } else if (this.lxMusicController && this.lxMusicController.isConnected()) {
            // Get real-time audio data from LX Music via its API
            this.lxMusicController.getAudioData()
                .then(audioData => {
                    if (audioData && audioData.length > 0) {
                        // Use real audio data from LX Music
                        for (let i = 0; i < this.dataArray.length; i++) {
                            this.dataArray[i] = audioData[i] || 0;
                        }
                        
                        // Process data for 3D Sphere
                        const overallSum = this.dataArray.reduce((a, b) => a + b, 0);
                        avgTarget = overallSum / this.dataArray.length;
                        bassTarget = this.dataArray[5] / 255; // Low frequency index
                        
                        // Update smoothed values based on real audio data
                        this.smoothedAvg = this.lerp(this.smoothedAvg, avgTarget / 255, 0.1);
                        this.smoothedBass = this.lerp(this.smoothedBass, bassTarget, 0.08);
                    } else {
                        // Fallback: Use cached LX Music data for visualization
                        const statusCache = this.lxMusicController.getStatusCache();
                        const progressRatio = statusCache.progress / statusCache.duration;
                        const status = statusCache.status;
                        
                        // Generate simulated frequency data based on progress and time
                        const baseFreq = 0.5 + progressRatio * 5; // Base frequency range based on progress
                        for (let i = 0; i < this.dataArray.length; i++) {
                            // Create a more dynamic waveform with multiple harmonics
                            const harmonic1 = Math.sin(this.time * baseFreq * 2 + i * 0.2) * 50;
                            const harmonic2 = Math.sin(this.time * baseFreq * 5 + i * 0.5) * 30;
                            const harmonic3 = Math.sin(this.time * baseFreq * 10 + i * 0.8) * 20;
                            
                            // Apply progress as a multiplier
                            let value = (harmonic1 + harmonic2 + harmonic3) * progressRatio;
                            
                            // When paused, reduce the animation intensity but keep some movement
                            if (status !== 'playing') {
                                value = value * 0.2; // Reduce to 20% when paused
                            }
                            
                            this.dataArray[i] = Math.max(0, Math.min(255, value)); // Clamp between 0 and 255
                        }
                        
                        // Update visualization values based on simulated data
                        const overallSum = this.dataArray.reduce((a, b) => a + b, 0);
                        avgTarget = overallSum / this.dataArray.length / 100; // Normalize
                        bassTarget = this.dataArray[5] / 255;
                        
                        // Update smoothed values based on LX Music progress and status
                        if (status === 'playing') {
                            this.smoothedAvg = this.lerp(this.smoothedAvg, progressRatio * (0.5 + Math.sin(this.time * 3) * 0.1), 0.1);
                            this.smoothedBass = this.lerp(this.smoothedBass, progressRatio * 0.5 * (0.7 + Math.cos(this.time * 2) * 0.3), 0.08);
                        } else {
                            // When paused, maintain a minimal animation to avoid complete stillness
                            this.smoothedAvg = this.lerp(this.smoothedAvg, 0.05, 0.05); // Keep minimal movement
                            this.smoothedBass = this.lerp(this.smoothedBass, 0.02, 0.05);
                        }
                    }
                    
                    // Draw Mini Monitor with LX Music data
                    this.drawMonitor(this.dataArray);
                })
                .catch(err => {
                    // Error occurred while fetching real audio data, fallback to progress-based simulation
                    const statusCache = this.lxMusicController.getStatusCache();
                    const progressRatio = statusCache.progress / statusCache.duration;
                    const status = statusCache.status;
                    
                    // Generate simulated frequency data based on progress
                    for (let i = 0; i < this.dataArray.length; i++) {
                        this.dataArray[i] = Math.sin(this.time * 10 + i * 0.5) * 100 * progressRatio;
                        
                        // When paused, reduce animation intensity
                        if (status !== 'playing') {
                            this.dataArray[i] = this.dataArray[i] * 0.2; // Reduce to 20% when paused
                        }
                    }
                    
                    // Update visualization values
                    const overallSum = this.dataArray.reduce((a, b) => a + b, 0);
                    avgTarget = overallSum / this.dataArray.length / 100;
                    bassTarget = this.dataArray[5] / 255;
                    
                    // Update smoothed values based on LX Music progress and status
                    if (status === 'playing') {
                        this.smoothedAvg = this.lerp(this.smoothedAvg, progressRatio, 0.1);
                        this.smoothedBass = this.lerp(this.smoothedBass, progressRatio * 0.5, 0.08);
                    } else {
                        // When paused, maintain a minimal animation to avoid complete stillness
                        this.smoothedAvg = this.lerp(this.smoothedAvg, 0.05, 0.05); // Keep minimal movement
                        this.smoothedBass = this.lerp(this.smoothedBass, 0.02, 0.05);
                    }
                    
                    // Draw Mini Monitor with LX Music data
                    this.drawMonitor(this.dataArray);
                });
        } else {
            // Idle monitor animation - keep the visualization active with subtle animation
            this.drawIdleMonitor(this.time);
        }

        // Use LX Music data if connected, otherwise use local audio
        if (!(this.lxMusicController && this.lxMusicController.isConnected())) {
            // Smooth audio values for physics
            this.smoothedBass = this.lerp(this.smoothedBass, bassTarget, 0.08); 
            this.smoothedAvg = this.lerp(this.smoothedAvg, avgTarget / 255, 0.1);
        } 
        // For LX Music, the values are already updated in the above condition

        // 3D Sphere logic
        const scaleTarget = 1 + (this.smoothedBass * 0.3); 
        this.sphere.scale.lerp(new THREE.Vector3(scaleTarget, scaleTarget, scaleTarget), 0.05);

        const positions = this.sphere.geometry.attributes.position.array;
        const audioForce = this.smoothedAvg * 5.0; 

        for (let i = 0; i < this.count; i++) {
            const px = this.originalPositions[i * 3];
            const py = this.originalPositions[i * 3 + 1];
            const pz = this.originalPositions[i * 3 + 2];

            let noise = Math.sin(px * 0.4 + this.time * 2) * 
                        Math.cos(py * 0.3 + this.time * 1.5) * 
                        Math.sin(pz * 0.4 + this.time * 2.5);

            const displacement = 1 + (noise * 0.1) + (noise * audioForce * 0.25);

            positions[i * 3]     = px * displacement;
            positions[i * 3 + 1] = py * displacement;
            positions[i * 3 + 2] = pz * displacement;
        }
        this.sphere.geometry.attributes.position.needsUpdate = true;
        
        // Only apply auto-rotation and audio-affected rotation when not dragging
        if (!this.isDragging) {
            // Smoothly transition to target rotation angle (based on mouse position)
            this.sphere.rotation.x = this.lerp(this.sphere.rotation.x, this.targetRotationX, 0.05);
            this.sphere.rotation.y = this.lerp(this.sphere.rotation.y, this.targetRotationY, 0.05);
        }
        
        // Apply audio-based auto-rotation
        this.sphere.rotation.z = -this.time * 0.25 * (this.smoothedAvg * 0.5 + 0.5);
        
        // Render the scene
        this.renderer.render(this.scene, this.camera);
    }
    
    // Function to draw frequency monitor
    drawMonitor(data) {
        this.monitorCtx.clearRect(0, 0, this.monitorCanvas.width, this.monitorCanvas.height);
        this.monitorCtx.fillStyle = '#00f2ff'; // Cyan color
        
        const barWidth = 3;
        const gap = 1;
        const step = Math.floor(data.length / (this.monitorCanvas.width / (barWidth + gap)));

        for (let i = 0; i < this.monitorCanvas.width; i += (barWidth + gap)) {
            // Grab data from frequency array
            const dataIndex = Math.floor(i / (barWidth + gap)) * step;
            const value = data[dataIndex] || 0;
            const percent = value / 255;
            const barHeight = percent * this.monitorCanvas.height;

            // Draw bar from bottom up
            this.monitorCtx.globalAlpha = 0.5 + (percent * 0.5); // Brighter if louder
            this.monitorCtx.fillRect(i, this.monitorCanvas.height - barHeight, barWidth, barHeight);
        }
    }

    drawIdleMonitor(t) {
        this.monitorCtx.clearRect(0, 0, this.monitorCanvas.width, this.monitorCanvas.height);
        this.monitorCtx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        
        // Just a simple sine wave for idle state
        for (let i = 0; i < this.monitorCanvas.width; i += 4) {
            const h = 10 + Math.sin(i * 0.1 + t * 5) * 6; // Scale height proportionally
            this.monitorCtx.fillRect(i, this.monitorCanvas.height - h, 3, h);
        }
    }
    
    // Initialize audio context and analyser
    initAudio(analyser, dataArray) {
        this.analyser = analyser;
        this.dataArray = dataArray;
        this.isAudioInit = true;
    }
    
    // Set LX Music controller for integration
    setLXMusicController(lxMusicController) {
        this.lxMusicController = lxMusicController;
    }
    
    // Get the renderer dom element
    getRendererElement() {
        return this.renderer ? this.renderer.domElement : null;
    }
    
    // Update audio data array
    updateAudioData(newDataArray) {
        this.dataArray = newDataArray;
    }
    
    // Get current analyser
    getAnalyser() {
        return this.analyser;
    }
    
    // Get audio init status
    getAudioInitStatus() {
        return this.isAudioInit;
    }
}

// Export for use in other modules (if using modules) or create global instance
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ThreeDScene;
}