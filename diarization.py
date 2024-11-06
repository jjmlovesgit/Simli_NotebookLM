import os
import time
import warnings
import torch
from pyannote.audio import Pipeline

# Suppress specific warnings
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

# Retrieve the Hugging Face token from environment variables
hf_token = os.getenv("HF_TOKEN", "your-default-token-here")  # Make sure to set this token in your environment

# Global pipeline variable to avoid reinitializing the model on each request
pipeline = None

# Initialize the pipeline if it's not already initialized
def initialize_pipeline():
    global pipeline
    if pipeline is None:
        try:
            print("Loading diarization model...")
            pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization@2.1", use_auth_token=hf_token)
            pipeline = pipeline.to(torch.device('cuda:0') if torch.cuda.is_available() else torch.device('cpu'))
            print("Pipeline loaded successfully.")
        except Exception as e:
            print(f"Error loading pipeline: {e}")
            pipeline = None
    return pipeline

# Diarize the audio file using a pre-initialized model and get timestamps
def diarize_audio(audio_file_path, model, num_speakers=None):
    if not model:
        print("No model found, cannot proceed with diarization.")
        return None  # Exit if the model is not initialized

    print(f"Processing file: {audio_file_path}")
    start_time = time.time()

    try:
        # Run diarization with or without a specified number of speakers
        diarization = model(audio_file_path, num_speakers=num_speakers) if num_speakers else model(audio_file_path)
    except Exception as e:
        print(f"Error during diarization: {e}")
        return None

    # Processing completion
    print(f"Diarization complete in {time.time() - start_time:.2f} seconds.")

    # Write results to a text file in the expected format
    with open("diarization_results.txt", "w") as f:
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            start_time = turn.start
            end_time = turn.end
            speaker_label = speaker

            # Format each speaker's time segment as required by server.py
            segment_info = f"{speaker_label}: {start_time:.2f}s to {end_time:.2f}s"
            print(segment_info)  # Print to console for immediate feedback
            f.write(f"{speaker_label}: {start_time:.2f} to {end_time:.2f}\n")

    return diarization  # Return the diarization object for further processing if needed

# Only execute this block if the script is run directly (not imported as a module)
if __name__ == "__main__":
    audio_file = "latest_audio.wav"  # Path to the audio file for processing
    model = initialize_pipeline()  # Initialize the pipeline
    diarization = diarize_audio(audio_file, model=model, num_speakers=2)  # Pass model and speaker count

    if diarization:
        print("Diarization results written to diarization_results.txt")
    else:
        print("Diarization failed.")
