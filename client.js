var dataChannelLog = document.getElementById("data-channel"),
    iceConnectionLog = document.getElementById("ice-connection-state"),
    iceGatheringLog = document.getElementById("ice-gathering-state"),
    signalingLog = document.getElementById("signaling-state"),
    avatarStatus1 = document.getElementById("avatarStatus1"),
    avatarStatus2 = document.getElementById("avatarStatus2");

let API_KEY, FACE_ID_SPEAKER_00, FACE_ID_SPEAKER_01;

let isAvatar00Ready = false;
let isAvatar01Ready = false;
let candidateCount = 0;
let prevCandidateCount = -1;

async function loadEnvVariables() {
    try {
        const response = await fetch("http://127.0.0.1:8080/get_env_vars");
        if (response.ok) {
            const data = await response.json();
            API_KEY = data.API_KEY;
            FACE_ID_SPEAKER_00 = data.FACE_ID_SPEAKER_00;
            FACE_ID_SPEAKER_01 = data.FACE_ID_SPEAKER_01;
            console.log("Environment variables loaded successfully");
        } else {
            throw new Error("Failed to load environment variables");
        }
    } catch (error) {
        console.error("Error loading environment variables:", error);
    }
}

// Function to update UI when avatar is ready
//function updateAvatarStatus(avatarId, status) {
//    const statusElement = avatarId === FACE_ID_SPEAKER_00 ? avatarStatus1 : avatarStatus2;
//    statusElement.style.color = status === "Ready" ? "green" : "red";
//    statusElement.textContent = status;
//}

// Avatar Initialization Function
async function initializeAvatar(videoRef, audioRef, faceId, speakerLabel) {
    let pc = null;
    let dc = null;
  
    async function getIceServers() {
        try {
            // Hardcoded ICE servers
            const iceServers = [
                { urls: "stun:stun.l.google.com:19302" },
                // Add any additional ICE servers as needed
            ];
            //console.log("Using hardcoded ICE servers:", iceServers); // Debugging log
            return iceServers;
        } catch (error) {
            console.error("Error in getIceServers:", error);
            return [];  // Return an empty array if fetching ICE servers fails
        }
    }
 }

async function initializeAvatar(videoRef, audioRef, faceId, speakerLabel) {
    let pc = null;
    let dc = null;
    let ws = null;
    let isWebSocketOpen = false;
    let isDataChannelOpen = false;

    async function getIceServers() {
        try {
            const iceServers = [
                { urls: "stun:stun.l.google.com:19302" },
            ];
            //console.log("Using hardcoded ICE servers:", iceServers);
            return iceServers;
        } catch (error) {
            console.error("Error in getIceServers:", error);
            return [];
        }
    }

    async function createPeerConnection() {
        try {
            const config = {
                sdpSemantics: "unified-plan",
                iceServers: await getIceServers(),
            };
            pc = new RTCPeerConnection(config);

            // Add transceivers for receiving audio and video
            pc.addTransceiver("audio", { direction: "recvonly" });
            pc.addTransceiver("video", { direction: "recvonly" });

            // Handle track events
            pc.addEventListener("track", (evt) => {
                if (evt.track.kind === "video" && videoRef) {
                    videoRef.srcObject = evt.streams[0];
                } else if (evt.track.kind === "audio" && audioRef) {
                    audioRef.srcObject = evt.streams[0];
                }
            });

            // Handle ICE candidates
            pc.onicecandidate = (event) => {
                if (event.candidate === null) {
                    //console.log("ICE candidate gathering complete.");
                } else {
                    candidateCount += 1;
                }
            };

            return pc;
        } catch (error) {
            console.error("Error creating peer connection:", error);
            return null; // Return null if peer connection creation fails
        }
    }

    async function connectToRemotePeer() {
        try {
            const offer = pc.localDescription;
            const response = await fetch("https://api.simli.ai/StartWebRTCSession", {
                body: JSON.stringify({ sdp: offer.sdp, type: offer.type }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });
            const answer = await response.json();
            await pc.setRemoteDescription(answer);
        } catch (error) {
            console.error("Error connecting to remote peer:", error);
            throw error;
        }
    }

    async function startWebRTC() {
        try {
            pc = await createPeerConnection();
            if (!pc) throw new Error("PeerConnection creation failed.");

            dc = pc.createDataChannel("datachannel", { ordered: true });
            if (!dc) throw new Error("Data channel creation failed.");

            // Track Data Channel status
            dc.addEventListener("open", async () => {
                console.log("Data channel opened for faceId:", faceId);
                isDataChannelOpen = true;
                checkAvatarReadiness();

                const metadata = {
                    faceId: faceId,
                    isJPG: false,
                    apiKey: API_KEY,
                    syncAudio: true,
                };

                const response = await fetch("https://api.simli.ai/startAudioToVideoSession", {
                    method: "POST",
                    body: JSON.stringify(metadata),
                    headers: { "Content-Type": "application/json" },
                });
                const resJSON = await response.json();
                dc.send(resJSON.session_token);
            });

            // Track WebSocket status
            ws = new WebSocket("ws://localhost:8080/");
            ws.binaryType = "arraybuffer";

            ws.onopen = () => {
                console.log(`WebSocket connected for faceId: ${faceId}`);
                isWebSocketOpen = true;
                checkAvatarReadiness();
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            // Wait for ICE candidates to complete
            let prevCandidateCount = candidateCount;
            async function checkIceCandidates() {
                while (pc.iceGatheringState !== "complete" && candidateCount !== prevCandidateCount) {
                    prevCandidateCount = candidateCount;
                    await new Promise((resolve) => setTimeout(resolve, 250));
                }
            }

            await checkIceCandidates();
            await connectToRemotePeer();

            // Return a valid object even if components fail
            return { dataChannel: dc, peerConnection: pc, webSocket: ws };

        } catch (err) {
            console.error("Error in startWebRTC:", err);
            return { dataChannel: null, peerConnection: null, webSocket: null };
        }
    }

    function checkAvatarReadiness() {
        if (isWebSocketOpen && isDataChannelOpen) {
            updateAvatarStatus(faceId, "Ready");
            if (faceId === FACE_ID_SPEAKER_00) isAvatar00Ready = true;
            if (faceId === FACE_ID_SPEAKER_01) isAvatar01Ready = true;
        }
    }

    try {
        const result = await startWebRTC();

        // Ensure we always return an object, even on failure
        if (!result.dataChannel || !result.peerConnection || !result.webSocket) {
            console.error(`Failed to initialize avatar for faceId: ${faceId}. Returning default object.`);
            return { dataChannel: null, peerConnection: null, webSocket: null };
        }
        
        return result;
    } catch (error) {
        console.error(`initializeAvatar failed for faceId: ${faceId}`, error);
        return { dataChannel: null, peerConnection: null, webSocket: null };
    }
}

// Function to retrieve segments for a given speaker
async function getSegmentsForSpeaker(speakerLabel) {
    const response = await fetch("diarization_results.txt");
    const text = await response.text();
    const regex = new RegExp(`${speakerLabel}:\\s*([\\d.]+)\\s*to\\s*([\\d.]+)`, "g");
    const matches = [...text.matchAll(regex)];
    return matches.map(match => ({
        start_time: parseFloat(match[1]),
        end_time: parseFloat(match[2])
    }));
}

// ___________________________________________________________________________________________

loadEnvVariables();

// Class to handle WebSocket playback for an avatar
class AvatarPlayer {
    constructor(faceId, dataChannel, speakerLabel) {
        this.faceId = faceId;
        this.speakerLabel = speakerLabel;
        this.dataChannel = dataChannel;
        this.ws = null;
        this.segments = [];
        this.currentSegmentIndex = 0;
        this.lastCompletedSegmentIndex = -1;
        this.pauseRequested = false;
        this.isPlaying = false;
        this.isDataChannelOpen = false;
        this.isWebSocketOpen = false;
    }

    async initializeWebSocket() {
        if (this.ws) {
            console.warn(`WebSocket for faceId ${this.faceId} already exists.`);
            return;
        }

        try {
            const rawSegments = await getSegmentsForSpeaker(this.speakerLabel);

            this.segments = rawSegments.map((segment, index) => ({
                ...segment,
                index
            }));

            if (this.segments.length === 0) {
                console.error(`No segments found for ${this.speakerLabel}`);
                return;
            }

            this.ws = new WebSocket("ws://localhost:8080/");
            this.ws.binaryType = "arraybuffer";

            this.ws.onopen = () => {
                if (!this.isWebSocketOpen) {
                    console.log(`WebSocket connected for faceId: ${this.faceId}`);
                    this.isWebSocketOpen = true;
                    this.checkAvatarReady();
                }
            };

            this.ws.onmessage = (event) => {
                if (this.isDataChannelOpen) {
                    console.log("WebSocket message received, forwarding to data channel");
                    this.dataChannel.send(event.data);
                }
            };

            this.ws.onclose = () => {
                console.log(`WebSocket closed for faceId: ${this.faceId}`);
            };

            this.dataChannel.addEventListener("open", () => {
                if (!this.isDataChannelOpen) {
                    console.log(`Data channel opened for faceId: ${this.faceId}`);
                    this.isDataChannelOpen = true;
                    this.checkAvatarReady();
                }
            });
        } catch (error) {
            console.error("Error initializing WebSocket:", error);
        }
    }

    checkAvatarReady() {
        if (this.isDataChannelOpen && this.isWebSocketOpen) {
            updateAvatarStatus(this.faceId, "Ready");
            if (this.faceId === FACE_ID_SPEAKER_00) isAvatar00Ready = true;
            if (this.faceId === FACE_ID_SPEAKER_01) isAvatar01Ready = true;
        }
    }

    async startPlayback() {
        if (this.isPlaying) {
            console.log(`Playback already active for ${this.speakerLabel}`);
            return;
        }

        this.isPlaying = true;
        console.log(`Playback started for ${this.speakerLabel}`);

        const referenceStartTime = Date.now() / 1000;

        for (let i = this.lastCompletedSegmentIndex + 1; i < this.segments.length; i++) {
            const { start_time, end_time, index } = this.segments[i];
            this.currentSegmentIndex = index;

            if (this.pauseRequested) {
                console.log(`Playback paused at segment index ${index} before sending segment.`);
                this.isPlaying = false;
                return;
            }

            const delay = start_time - (Date.now() / 1000 - referenceStartTime);
            if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay * 1000));

            if (this.pauseRequested) {
                console.log(`Playback paused at segment index ${index} after delay`);
                this.isPlaying = false;
                return;
            }

            this.ws.send(JSON.stringify({ start_time, end_time }));
            console.log(`Sent request for segment from ${start_time}s to ${end_time}s for faceId: ${this.faceId}`);
            this.lastCompletedSegmentIndex = index;

            if (this.pauseRequested) {
                console.log(`Playback paused mid-segment at ${start_time}s to ${end_time}s, index ${index}`);
                this.isPlaying = false;
                return;
            }
        }

        this.isPlaying = false;
    }
}

// Stop function to reset page
function stopPlayback() {
    console.log("Stopping playback and refreshing the page.");
    location.reload();
}

// Event listener for the Cancel Playback button
document.getElementById("stopPlayback").addEventListener("click", () => {
    stopPlayback();
});

// Avatar player initialization and setup function
async function setupAvatar(faceId, speakerLabel, videoElement, audioElement) {
    const { dataChannel } = await initializeAvatar(videoElement, audioElement, faceId, speakerLabel);

    const avatarPlayer = new AvatarPlayer(faceId, dataChannel, speakerLabel);
    await avatarPlayer.initializeWebSocket();

    return avatarPlayer;
}

// Combined button handler to start both avatars with automatic retries
document.getElementById("startBothAvatars").addEventListener("click", () => {
    isAvatar00Ready = false;
    isAvatar01Ready = false;
    document.getElementById("avatarStatus1").textContent = "Avatar 1: Not Ready";
    document.getElementById("avatarStatus2").textContent = "Avatar 2: Not Ready";

    console.log("Starting avatar setup with automatic retries...");
    retrySetupAvatarsUntilReady();
});

// Retry setup of avatars until both are ready
async function retrySetupAvatarsUntilReady() {
    const maxRetries = 5;
    let attempt = 1;

    console.log("Entering retry loop for avatar setup...");

    while (attempt <= maxRetries) {
        console.log(`Loop Start - Attempt ${attempt}: Checking readiness of both avatars...`);

        if (!isAvatar00Ready) {
            console.log(`Setting up Avatar 1 (Attempt ${attempt})...`);
            window.avatar00 = await setupAvatar(FACE_ID_SPEAKER_00, "SPEAKER_00", document.getElementById("video1"), document.getElementById("audio1"));
            console.log(`Avatar 1 setup status after attempt ${attempt}: ${isAvatar00Ready ? "Ready" : "Not Ready"}`);
        }

        if (!isAvatar01Ready) {
            console.log(`Setting up Avatar 2 (Attempt ${attempt})...`);
            window.avatar01 = await setupAvatar(FACE_ID_SPEAKER_01, "SPEAKER_01", document.getElementById("video2"), document.getElementById("audio2"));
            console.log(`Avatar 2 setup status after attempt ${attempt}: ${isAvatar01Ready ? "Ready" : "Not Ready"}`);
        }

        if (isAvatar00Ready && isAvatar01Ready) {
            console.log("Both avatars are now ready. Exiting retry loop.");
            break;
        } else {
            console.log(`Both avatars not ready yet after attempt ${attempt}.`);
        }

        attempt++;
        //let delay = Math.min(1000 * (2 ** attempt) + Math.random() * 1000, 5000);
        let delay = Math.min(100 * (2 ** attempt) + Math.random() * 500, 2500);
        console.log(`Retrying in ${Math.round(delay / 1000)} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    if (!isAvatar00Ready || !isAvatar01Ready) {
        console.warn("Max retries reached. One or both avatars failed to reach 'Ready' state.");
    } else {
        console.log("Both avatars confirmed ready.");
    }
}

// Function to update UI when avatar is ready
function updateAvatarStatus(avatarId, status) {
    const statusElement = avatarId === FACE_ID_SPEAKER_00 ? avatarStatus1 : avatarStatus2;
    statusElement.style.color = status === "Ready" ? "green" : "red";
    statusElement.textContent = status;
}

// Play both avatars, initializing only if not already ready
document.getElementById("playBothAvatars").addEventListener("click", async () => {
    if (!isAvatar00Ready) {
        window.avatar00 = await setupAvatar(FACE_ID_SPEAKER_00, "SPEAKER_00", document.getElementById("video1"), document.getElementById("audio1"));
    }
    if (!isAvatar01Ready) {
        window.avatar01 = await setupAvatar(FACE_ID_SPEAKER_01, "SPEAKER_01", document.getElementById("video2"), document.getElementById("audio2"));
    }

    if (isAvatar00Ready && isAvatar01Ready) {
        console.log("Both avatars are now playing.");
        
        // Adding a brief delay to ensure connections are fully stable before playback
        await new Promise(resolve => setTimeout(resolve, 750));

        if (window.avatar00) window.avatar00.startPlayback();
        if (window.avatar01) window.avatar01.startPlayback();

        console.log("Playback started for both avatars.");
    }
});

function showSpinner() {
    document.getElementById("spinner").style.display = "block";
}

function hideSpinner() {
    document.getElementById("spinner").style.display = "none";
}

document.getElementById("combinedPlayButton").addEventListener("click", async () => {
    console.log("Combined Play button clicked.");

    // Step 1: Show the spinner
    showSpinner();

    // Step 2: Trigger "Start Both Avatars" button
    document.getElementById("startBothAvatars").click();

    // Step 3: Wait for both avatars to be ready
    await waitForAvatarsToBeReady();

    // Step 4: Hide the spinner once avatars are ready
    hideSpinner();

    //Step 5: Trigger "Play the Vodcast" button
    document.getElementById("playBothAvatars").click();
    console.log("Playback started for both avatars.");
});

// Function to wait for avatars to be ready
async function waitForAvatarsToBeReady() {
    console.log("Waiting for both avatars to be ready...");
    while (!isAvatar00Ready || !isAvatar01Ready) {
        await new Promise(resolve => setTimeout(resolve, 500)); // Check readiness every 200ms
    }
    console.log("Both avatars are now ready.");
}

//  Record Avatars >>>>>>>>>>>>>>>____________Experimental______________>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

// DOM elements and global variables
var dataChannelLog = document.getElementById("data-channel"),
    iceConnectionLog = document.getElementById("ice-connection-state"),
    iceGatheringLog = document.getElementById("ice-gathering-state"),
    signalingLog = document.getElementById("signaling-state"),
    avatarStatus1 = document.getElementById("avatarStatus1"),
    avatarStatus2 = document.getElementById("avatarStatus2");

let audioContext;
let destination;
let recorder;
let isRecording = false;
let recordedChunks = [];

async function loadEnvVariables() {
    try {
        const response = await fetch("http://127.0.0.1:8080/get_env_vars");
        if (response.ok) {
            const data = await response.json();
            API_KEY = data.API_KEY;
            FACE_ID_SPEAKER_00 = data.FACE_ID_SPEAKER_00;
            FACE_ID_SPEAKER_01 = data.FACE_ID_SPEAKER_01;
            console.log("Environment variables loaded successfully");
        } else {
            throw new Error("Failed to load environment variables");
        }
    } catch (error) {
        console.error("Error loading environment variables:", error);
    }
}

// Initialize avatars and setup video/audio recording
async function setupAvatarRecording(videoRef1, videoRef2, audioRef1, audioRef2) {
    if (!audioContext) {
        audioContext = new AudioContext();
        destination = audioContext.createMediaStreamDestination();
    }

    // Attach audio elements to destination
    const audioSource1 = audioContext.createMediaElementSource(audioRef1);
    const audioSource2 = audioContext.createMediaElementSource(audioRef2);
    audioSource1.connect(destination);
    audioSource2.connect(destination);

    // Prepare canvas for video streams
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = 1920;
    canvas.height = 1080;

    function drawFrame() {
        context.clearRect(0, 0, canvas.width, canvas.height);
        const halfWidth = canvas.width / 2;
        if (videoRef2.readyState === 4) context.drawImage(videoRef2, 0, 0, halfWidth, canvas.height);
        if (videoRef1.readyState === 4) context.drawImage(videoRef1, halfWidth, 0, halfWidth, canvas.height);
        requestAnimationFrame(drawFrame);
    }
    drawFrame();

    // Combine video and audio streams
    const canvasStream = canvas.captureStream(30); // Video stream at 30 FPS
    const combinedStream = new MediaStream([...canvasStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);

    // Set up MediaRecorder with MIME type
    recorder = new MediaRecorder(combinedStream, { mimeType: "video/webm; codecs=vp9" });
    recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunks.push(event.data);
    };

    recorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "avatar_recording.webm";
        document.body.appendChild(a);
        a.click();
        URL.revokeObjectURL(url);
        recordedChunks = []; // Reset for next recording
    };
}

// Function to start recording
function startRecording() {
    if (recorder && !isRecording) {
        recorder.start();
        isRecording = true;
        console.log("Recording started.");
    }
}

// Event listeners for combined play button and stop button
// ***********************************delete previous files and start combined playback
document.getElementById("combinedPlayButton").addEventListener("click", async () => {
    console.log("Combined Play button clicked.");
    showSpinner();

    // Delete previous recording file first
    await deletePreviousRecording();

    // Start playback and recording
    document.getElementById("playBothAvatars").click();
    setupAvatarRecording(document.getElementById("video1"), document.getElementById("video2"), document.getElementById("audio1"), document.getElementById("audio2"));
    startRecording();
    console.log("Playback and recording initialized.");
});

document.getElementById("stopPlayback").addEventListener("click", () => {
    stopRecording();
    console.log("Recording stopped via cancel button.");
});

// Function to stop recording and trigger download
function stopRecording() {
    if (recorder && isRecording) {
        recorder.stop();
        console.log("Recording stopped");
    }
}

async function syncAudioVideo() {
    const syncButton = document.getElementById("syncButton");
    const statusMessage = document.getElementById("diarizationStatus"); // Feedback div

    // Disable button to prevent duplicate requests
    syncButton.disabled = true;
    statusMessage.innerText = "Syncing video and audio...";

    try {
        // Call the server endpoint to sync audio and video
        const response = await fetch("http://127.0.0.1:8080/sync_audio_video", { method: "POST" });
        
        if (response.ok) {
            const result = await response.json();
            statusMessage.innerText = result.message;
            console.log(result.message);
        } else {
            const errorData = await response.json();
            statusMessage.innerText = `Error: ${errorData.detail}`;
            console.error("Server error:", errorData);
        }
    } catch (error) {
        statusMessage.innerText = "Failed to connect to server.";
        console.error("Connection error:", error);
    } finally {
        // Re-enable the sync button after processing completes
        syncButton.disabled = false;
    }
}


// Event listeners for buttons
async function deletePreviousRecording() {
    try {
        const response = await fetch("http://127.0.0.1:8080/delete_previous_recording", {
            method: "POST"
        });
        if (response.ok) {
            const result = await response.json();
            console.log(result.message); // Log success message from the server
        } else {
            console.error("Error deleting previous recording:", await response.text());
        }
    } catch (error) {
        console.error("Failed to connect to server for deletion:", error);
    }
}

// Event listener for syncing video and audio
document.getElementById("syncButton").addEventListener("click", async () => {
    const statusMessage = document.getElementById("diarizationStatus"); // Using diarizationStatus div for feedback

    statusMessage.innerText = "Syncing video and audio...";

    try {
        // Call the server endpoint to sync audio and video
        const response = await fetch("http://127.0.0.1:8080/sync_audio_video", { method: "POST" });
        
        if (response.ok) {
            const result = await response.json();
            statusMessage.innerText = result.message;
            console.log(result.message);
        } else {
            const errorData = await response.json();
            statusMessage.innerText = `Error: ${errorData.detail}`;
            console.error("Server error:", errorData);
        }
    } catch (error) {
        statusMessage.innerText = "Failed to connect to server.";
        console.error("Connection error:", error);
    }
});