import os
from pathlib import Path
import asyncio
import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from diarization import diarize_audio, initialize_pipeline
import datetime  
import random

print("Loading commencing...")

app = FastAPI()

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

model = initialize_pipeline()
if model is None:
    logger.error("Failed to load diarization model at startup")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5500"],  # Adjusted for specific origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/get_env_vars")
async def get_env_vars():
    return {
        "API_KEY": os.getenv("API_KEY"),
        "FACE_ID_SPEAKER_00": os.getenv("FACE_ID_SPEAKER_00"),
        "FACE_ID_SPEAKER_01": os.getenv("FACE_ID_SPEAKER_01"),
    }

async def process_audio_segment(start_time, end_time):
    logger.info(f"Starting FFmpeg process for segment {start_time}s to {end_time}s")
    try:
        decode_task = await asyncio.create_subprocess_exec(
            "ffmpeg", "-i", "latest_audio.wav",
            "-ss", str(start_time),
            "-to", str(end_time),
            "-f", "s16le", "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le", "-",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        return decode_task
    except Exception as e:
        logger.error(f"Error starting FFmpeg process: {e}")
        return None

@app.websocket("/")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("WebSocket connection established")

    try:
        while True:
            message = await websocket.receive_json()
            start_time = message.get("start_time")
            end_time = message.get("end_time")

            if start_time is not None and end_time is not None:
                logger.info(f"Processing requested audio segment: {start_time}s to {end_time}s")
                decode_task = await process_audio_segment(start_time, end_time)

                if not decode_task:
                    await websocket.send_json({"error": "Audio processing failed"})
                    continue

                while True:
                    audio_data = await decode_task.stdout.read(16000)
                    if not audio_data:
                        break
                    await websocket.send_bytes(audio_data)

                _, stderr = await decode_task.communicate()
                if decode_task.returncode != 0:
                    error_message = stderr.decode()
                    logger.error(f"FFmpeg error: {error_message}")
                    await websocket.send_json({"error": "Audio processing failed", "details": error_message})

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception as e:
        logger.error(f"Unexpected error in WebSocket: {e}")
    finally:
        pass

@app.post("/diarize_audio")
async def diarize_audio_endpoint(audio: UploadFile = File(...)):
    """Endpoint to handle diarization of uploaded audio files, saved in root as latest_audio.wav."""
    if audio.content_type not in ["audio/wav", "audio/mpeg"]:
        raise HTTPException(status_code=400, detail="Invalid file type. Only WAV and MP3 files are allowed.")

    audio_file_path = Path("latest_audio.wav")
    results_file_path = Path("diarization_results.txt")

    # Delete the existing results file to trigger fresh diarization
    if results_file_path.exists():
        results_file_path.unlink()

    # Save the uploaded file as latest_audio.wav
    with open(audio_file_path, "wb") as f:
        f.write(await audio.read())

    try:
        # Only perform diarization if results file is not present
        if not results_file_path.exists():
            # Use the globally loaded model for diarization
            diarization_result = diarize_audio(audio_file_path, model=model, num_speakers=2)
            if diarization_result:
                return {"message": "Diarization complete"}
            else:
                raise HTTPException(status_code=500, detail="Diarization failed.")
        else:
            logger.info("Diarization results already exist, skipping processing.")
            return {"message": "Diarization results already exist, skipping processing."}
    except Exception as e:
        logger.error(f"Error in diarization: {e}")
        raise HTTPException(status_code=500, detail="Diarization processing error")

# Delete any previous previous webm file
@app.post("/delete_previous_recording")
async def delete_previous_recording():
    downloads_path = Path(os.environ["USERPROFILE"]) / "Downloads" / "avatar_recording.webm"

    logger.info(f"Checking for file at path: {downloads_path}")

    if downloads_path.exists():
        downloads_path.unlink()  
        logger.info("Previous avatar recording deleted successfully.")
        return {"message": "Previous avatar recording deleted successfully."}
    else:
        logger.info("No previous avatar recording found at the specified path.")
        return {"message": "No previous avatar recording found at the specified path."}

# Audio and Video Sync - The tricky part :)
@app.post("/sync_audio_video")
async def sync_audio_video():
    """Endpoint to detect black duration and sync audio and video."""
    
    downloads_path = Path(os.environ["USERPROFILE"]) / "Downloads"
    avatar_video_path = downloads_path / "avatar_recording.webm"
    audio_path = Path("latest_audio.wav")  

    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    random_suffix = random.randint(1000, 9999)
    output_filename = f"podcastvideo_{timestamp}_{random_suffix}.mp4"
    output_path = downloads_path / output_filename

    if not avatar_video_path.exists():
        logger.error(f"Video file not found: {avatar_video_path}")
        raise HTTPException(status_code=404, detail=f"Video file not found: {avatar_video_path}")
    if not audio_path.exists():
        logger.error(f"Audio file not found: {audio_path}")
        raise HTTPException(status_code=404, detail=f"Audio file not found: {audio_path}")

    # Step 1: Detect any intitail black screen buffer so we can trim it out duration with pic_th=0.98
    detect_black_cmd = [
        "ffmpeg", "-i", str(avatar_video_path), "-vf", "blackdetect=d=0.1:pic_th=0.98", "-an", "-f", "null", "-"
    ]
    try:
        detect_process = await asyncio.create_subprocess_exec(
            *detect_black_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        _, stderr = await detect_process.communicate()
        
        if detect_process.returncode != 0:
            error_message = stderr.decode()
            logger.error(f"FFmpeg error in black detection: {error_message}")
            raise HTTPException(status_code=500, detail="Error detecting black duration.")

        black_duration = None
        for line in stderr.decode().splitlines():
            if "black_end:" in line:
                black_duration = float(line.split("black_end:")[1].split()[0].strip())
                break  

        if black_duration is not None:
            logger.info(f"Using black duration: {black_duration} seconds")
        else:
            raise HTTPException(status_code=500, detail="Failed to parse black duration from video.")

    except Exception as e:
        logger.error(f"Error in black detection: {e}")
        raise HTTPException(status_code=500, detail="Black duration detection error.")

    # Step 2: Sync video and audio with volume adjustment
    sync_cmd = [
        "ffmpeg", "-i", str(avatar_video_path), "-itsoffset", str(black_duration), "-i", str(audio_path),
        "-filter:a", "volume=1.5", "-c:v", "copy", "-c:a", "aac", "-map", "0:v:0", "-map", "1:a:0", "-shortest", str(output_path)
    ]
    try:
        logger.info(f"Running sync command: {' '.join(sync_cmd)}")
        sync_process = await asyncio.create_subprocess_exec(
            *sync_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        _, stderr = await sync_process.communicate()
        
        if sync_process.returncode != 0:
            error_message = stderr.decode()
            logger.error(f"FFmpeg error in audio-video sync: {error_message}")
            raise HTTPException(status_code=500, detail="Error syncing audio and video.")

        logger.info(f"Audio and video sync complete. Output saved to {output_path}")
        return {"message": f"Sync complete. Output file created at {output_path}"}

    except Exception as e:
        logger.error(f"Error in audio-video sync: {e}")
        raise HTTPException(status_code=500, detail="Audio-video sync error")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8080)
