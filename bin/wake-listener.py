#!/usr/bin/env python3
"""
JARVIS Wake Word Listener

Continuously listens for "Hey Jarvis" via OpenWakeWord.
When detected:
  1. Plays acknowledgment chime (or speaks "Sir?")
  2. Records user's command until silence
  3. Pipes audio to whisper.cpp for transcription
  4. Sends transcript to Claude
  5. Speaks Claude's response via ElevenLabs

Designed to run as a LaunchAgent (always-on background service).
"""

import os
import sys
import time
import json
import subprocess
import tempfile
import signal
from pathlib import Path

import numpy as np
import sounddevice as sd
from openwakeword.model import Model

# ─── Configuration ────────────────────────────────────────────────────
JARVIS_DIR = Path(os.environ.get("JARVIS_DIR", Path.home() / ".jarvis"))
BIN_DIR = JARVIS_DIR / "bin"
LOG_DIR = JARVIS_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

# Audio config
SAMPLE_RATE = 16000
CHUNK_SIZE = 1280  # 80ms chunks at 16kHz (OpenWakeWord requirement)
WAKE_THRESHOLD = 0.5  # Confidence threshold (0-1)
COOLDOWN_SECONDS = 3  # Prevent re-triggering immediately

# Get assistant name from settings
def get_assistant_name():
    try:
        with open(JARVIS_DIR / "config" / "settings.json") as f:
            return json.load(f).get("assistant_name", "Jarvis")
    except Exception:
        return "Jarvis"

ASSISTANT_NAME = get_assistant_name()
ASSISTANT_SLUG = ASSISTANT_NAME.lower().replace(" ", "")

# ─── Logging ──────────────────────────────────────────────────────────
def log(msg):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {msg}", flush=True)

# ─── Audio playback for acknowledgment ────────────────────────────────
def play_chime():
    """Play a brief acknowledgment sound when wake word detected."""
    # Use afplay with system sound, fallback to a generated beep
    try:
        # Try a built-in macOS sound that's brief and pleasant
        subprocess.run(
            ["afplay", "/System/Library/Sounds/Tink.aiff"],
            timeout=2,
            check=False,
            capture_output=True,
        )
    except Exception:
        pass

def speak(text):
    """Speak via the jarvis CLI (which uses ElevenLabs)."""
    jarvis_bin = BIN_DIR / ASSISTANT_SLUG
    if not jarvis_bin.exists():
        jarvis_bin = BIN_DIR / "jarvis"

    try:
        subprocess.run(
            [str(jarvis_bin), text],
            timeout=15,
            check=False,
            capture_output=True,
        )
    except Exception as e:
        log(f"speak failed: {e}")

# ─── Recording user command after wake ────────────────────────────────
def record_command(max_seconds=15, silence_seconds=1.5):
    """Record from mic until user pauses speaking."""
    log("Recording command...")

    audio_chunks = []
    silence_chunks = 0
    chunks_per_second = SAMPLE_RATE // CHUNK_SIZE
    silence_threshold_chunks = int(silence_seconds * chunks_per_second)
    max_chunks = max_seconds * chunks_per_second
    silence_amplitude = 500  # int16 amplitude threshold

    started_speaking = False
    chunk_count = 0

    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype=np.int16,
        blocksize=CHUNK_SIZE,
    ) as stream:
        while chunk_count < max_chunks:
            chunk, _ = stream.read(CHUNK_SIZE)
            chunk = chunk.flatten()
            audio_chunks.append(chunk)

            amplitude = np.abs(chunk).mean()

            if amplitude > silence_amplitude:
                silence_chunks = 0
                started_speaking = True
            elif started_speaking:
                silence_chunks += 1
                if silence_chunks >= silence_threshold_chunks:
                    log("Detected end of speech")
                    break

            chunk_count += 1

    if not started_speaking:
        log("No speech detected")
        return None

    # Combine and save to WAV
    audio = np.concatenate(audio_chunks)
    tmp_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_file.close()

    # Write WAV using sounddevice (via scipy fallback would be cleaner but we'll use raw)
    import wave
    with wave.open(tmp_file.name, "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio.tobytes())

    return tmp_file.name

# ─── Transcribe with whisper.cpp ──────────────────────────────────────
def transcribe(audio_path):
    """Use whisper.cpp to transcribe the recorded audio."""
    # Find whisper binary
    whisper_paths = [
        "whisper-cpp",
        "whisper-cli",
        "/usr/local/opt/whisper-cpp/bin/whisper-cli",
        "/opt/homebrew/opt/whisper-cpp/bin/whisper-cli",
    ]
    whisper_cmd = None
    for path in whisper_paths:
        try:
            result = subprocess.run(
                ["which", path] if "/" not in path else ["test", "-x", path],
                capture_output=True,
                check=False,
            )
            if result.returncode == 0:
                whisper_cmd = path
                break
        except Exception:
            pass

    if not whisper_cmd:
        log("whisper-cpp not found")
        return None

    # Find model
    model_path = JARVIS_DIR / "models" / "ggml-base.en.bin"
    if not model_path.exists():
        log(f"Model not found at {model_path}")
        return None

    try:
        result = subprocess.run(
            [whisper_cmd, "-m", str(model_path), "-f", audio_path, "-np", "-nt"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        text = result.stdout.strip()
        # Clean whisper output
        text = " ".join(text.split())
        return text if text else None
    except Exception as e:
        log(f"Transcribe failed: {e}")
        return None

# ─── Send to Claude and speak response ────────────────────────────────
def respond(user_text):
    """Send to Claude via jarvis-converse --text and speak the response."""
    converse_bin = BIN_DIR / f"{ASSISTANT_SLUG}-converse"
    if not converse_bin.exists():
        converse_bin = BIN_DIR / "jarvis-converse"

    if not converse_bin.exists():
        log("converse binary not found")
        speak("I cannot reach my brain at the moment, sir.")
        return

    try:
        result = subprocess.run(
            [str(converse_bin), "--text", user_text],
            timeout=30,
            check=False,
            capture_output=True,
        )
        log(f"Response delivered (exit {result.returncode})")
    except Exception as e:
        log(f"respond failed: {e}")

# ─── Wake word handler ────────────────────────────────────────────────
def on_wake_detected():
    """Triggered when 'Hey Jarvis' is detected."""
    log("WAKE WORD DETECTED")

    # Acknowledge
    play_chime()
    # Could also: speak("Sir?") — but chime is faster and less annoying

    # Record command
    audio_path = record_command()
    if not audio_path:
        log("No command recorded")
        return

    # Transcribe
    user_text = transcribe(audio_path)
    try:
        os.unlink(audio_path)
    except Exception:
        pass

    if not user_text:
        log("No transcription")
        speak("I did not catch that, sir.")
        return

    log(f"User said: {user_text}")

    # Process and respond
    respond(user_text)

# ─── Main loop ────────────────────────────────────────────────────────
def main():
    log(f"JARVIS wake listener starting (assistant: {ASSISTANT_NAME})")

    # Load OpenWakeWord with the pretrained "hey jarvis" model
    log("Loading wake word model...")
    try:
        model = Model(
            wakeword_models=["hey_jarvis"],  # built-in pretrained model
            inference_framework="onnx",
        )
        log("Model loaded")
    except Exception as e:
        log(f"Failed to load model: {e}")
        log("Trying to download models...")
        from openwakeword.utils import download_models
        download_models()
        model = Model(
            wakeword_models=["hey_jarvis"],
            inference_framework="onnx",
        )

    log("Listening for 'Hey Jarvis'...")

    last_trigger = 0

    def audio_callback(indata, frames, time_info, status):
        nonlocal last_trigger

        if status:
            log(f"Audio status: {status}")

        # Convert to int16 mono
        audio = indata[:, 0] if indata.ndim > 1 else indata
        audio_int16 = (audio * 32767).astype(np.int16) if audio.dtype != np.int16 else audio

        # Get prediction
        predictions = model.predict(audio_int16)

        for wakeword, score in predictions.items():
            if score > WAKE_THRESHOLD:
                now = time.time()
                if now - last_trigger > COOLDOWN_SECONDS:
                    last_trigger = now
                    # Trigger in main thread (safer than from audio callback)
                    sd.stop()
                    on_wake_detected()
                    # Restart stream after handling
                    raise sd.CallbackStop()

    # Continuous listening with restart capability
    while True:
        try:
            with sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype=np.int16,
                blocksize=CHUNK_SIZE,
                callback=audio_callback,
            ):
                while True:
                    sd.sleep(100)
        except sd.CallbackStop:
            log("Stream stopped, restarting listener...")
            time.sleep(0.5)
            continue
        except KeyboardInterrupt:
            log("Stopped by user")
            break
        except Exception as e:
            log(f"Stream error: {e}")
            time.sleep(2)
            continue

if __name__ == "__main__":
    # Handle SIGTERM gracefully (LaunchAgent stop)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    main()
