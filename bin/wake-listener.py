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
import threading
from pathlib import Path

import numpy as np
import sounddevice as sd
from openwakeword.model import Model

# ─── Configuration ────────────────────────────────────────────────────
ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", Path.home() / ".jarvis"))
BIN_DIR = ASSISTANT_DIR / "bin"
LOG_DIR = ASSISTANT_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

# Audio config
SAMPLE_RATE = 16000
CHUNK_SIZE = 1280  # 80ms chunks at 16kHz (OpenWakeWord requirement)
WAKE_THRESHOLD = 0.5  # Confidence threshold (0-1)
COOLDOWN_SECONDS = 3  # Prevent re-triggering immediately

# Adaptive silence gate. The end-of-speech detector compares per-chunk mean
# amplitude against a threshold derived from ambient noise. A hand-tuned
# constant produced ~20% false negatives on AirPods (very low noise floor →
# the gate sat above the user's quieter syllables) and in noisy rooms (gate
# below ambient → recording never ended).
NOISE_CALIBRATION_SECONDS = 1.5
NOISE_PERCENTILE = 85          # robust to brief spikes during calibration
NOISE_GATE_MULTIPLIER = 2.5    # gate sits comfortably above the floor
NOISE_GATE_FLOOR = 80          # don't trust a near-zero floor (digital silence)
NOISE_GATE_CEILING = 1500      # don't let a noisy room mask normal speech
NOISE_GATE_FALLBACK = 300      # used if calibration itself fails

# Get assistant name from settings
def get_assistant_name():
    try:
        with open(ASSISTANT_DIR / "config" / "settings.json") as f:
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

# ─── Adaptive silence gate ────────────────────────────────────────────
# Cached per input-device name; cleared on device hot-swap so AirPods
# reconnects (or a switch to/from the built-in mic) trigger recalibration.
_silence_gate_cache = {}


def current_input_device_name():
    """Return a stable name for the active default input device."""
    try:
        default = sd.default.device
        idx = default[0] if isinstance(default, (list, tuple)) else default
        if idx is None or idx == -1:
            info = sd.query_devices(kind="input")
        else:
            info = sd.query_devices(idx)
        return info.get("name", "default") if isinstance(info, dict) else "default"
    except Exception:
        return "default"


def measure_silence_gate(duration_seconds=NOISE_CALIBRATION_SECONDS):
    """Sample ambient noise and derive an int16 amplitude threshold.

    Uses a percentile of per-chunk mean amplitudes (not max) so a stray
    cough during calibration doesn't inflate the gate, and clamps the
    result so neither digital-silence nor a loud room produces a useless
    threshold.
    """
    chunks_needed = max(4, int(duration_seconds * SAMPLE_RATE / CHUNK_SIZE))
    amps = []
    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype=np.int16,
            blocksize=CHUNK_SIZE,
        ) as stream:
            for _ in range(chunks_needed):
                chunk, _ = stream.read(CHUNK_SIZE)
                amps.append(float(np.abs(chunk.flatten()).mean()))
    except Exception as e:
        log(f"Noise calibration failed ({e}); using fallback gate {NOISE_GATE_FALLBACK}")
        return NOISE_GATE_FALLBACK

    if not amps:
        return NOISE_GATE_FALLBACK

    noise_floor = float(np.percentile(amps, NOISE_PERCENTILE))
    gate = int(max(NOISE_GATE_FLOOR, min(NOISE_GATE_CEILING, noise_floor * NOISE_GATE_MULTIPLIER)))
    log(f"Noise floor p{NOISE_PERCENTILE}={noise_floor:.0f} → silence gate={gate}")
    return gate


def get_silence_gate():
    """Return the cached silence gate for the current device, calibrating if needed."""
    device = current_input_device_name()
    cached = _silence_gate_cache.get(device)
    if cached is not None:
        return cached
    log(f"Calibrating silence gate for input device: {device}")
    gate = measure_silence_gate()
    _silence_gate_cache[device] = gate
    return gate


def reset_silence_gate_cache():
    """Drop calibration so the next record_command recalibrates from scratch."""
    if _silence_gate_cache:
        log("Clearing silence-gate cache (device change or stream error)")
    _silence_gate_cache.clear()


# ─── Recording user command after wake ────────────────────────────────
def record_command(max_seconds=15, silence_seconds=1.5):
    """Record from mic until user pauses speaking."""
    log("Recording command...")

    audio_chunks = []
    silence_chunks = 0
    chunks_per_second = SAMPLE_RATE // CHUNK_SIZE
    silence_threshold_chunks = int(silence_seconds * chunks_per_second)
    max_chunks = max_seconds * chunks_per_second
    silence_amplitude = get_silence_gate()

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
    model_path = ASSISTANT_DIR / "models" / "ggml-base.en.bin"
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
# Generous ceiling for the full think + TTS pipeline. The previous 30s killed
# any response whose streamed audio took longer than that, leaking the orphan
# mpv/think children that then overlapped the next wake's response.
RESPOND_TIMEOUT_SECONDS = 90


def respond(user_text):
    """Send to Claude via jarvis-converse --text and speak the response.

    Spawned in its own process group (start_new_session=True) so a timeout
    can SIGKILL the entire pipeline — bash wrapper, jarvis-think.py, the
    jarvis TTS streamer, mpv. Without this, subprocess.run only kills the
    immediate bash child; orphaned mpv keeps playing and overlaps the next
    response when the wake re-fires (the "multiple responses at once" bug).
    """
    converse_bin = BIN_DIR / f"{ASSISTANT_SLUG}-converse"
    if not converse_bin.exists():
        converse_bin = BIN_DIR / "jarvis-converse"

    if not converse_bin.exists():
        log("converse binary not found")
        speak("I cannot reach my brain at the moment, sir.")
        return

    try:
        proc = subprocess.Popen(
            [str(converse_bin), "--text", user_text],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as e:
        log(f"respond failed to spawn: {e}")
        return

    try:
        rc = proc.wait(timeout=RESPOND_TIMEOUT_SECONDS)
        log(f"Response delivered (exit {rc})")
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            proc.wait(timeout=2)
        except (ProcessLookupError, PermissionError, subprocess.TimeoutExpired):
            pass
        log(f"respond timed out after {RESPOND_TIMEOUT_SECONDS}s — process group killed")
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

    log("Loading wake word model...")
    try:
        model = Model(
            wakeword_models=["hey_jarvis"],
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

    # Prime the silence gate before the wake stream opens so the first
    # post-wake recording uses a calibrated threshold instead of the
    # fallback. Runs in a tiny dedicated InputStream — the wake stream
    # isn't open yet, so there's no contention.
    try:
        get_silence_gate()
    except Exception as e:
        log(f"Startup calibration skipped: {e}")

    log("Listening for 'Hey Jarvis'...")

    # Thread-safe signal from audio callback to main loop. Doing the
    # conversation work (record/transcribe/respond) inside the audio callback
    # blocks PortAudio's audio thread for 30+ seconds and risks deadlock when
    # we try to open another InputStream from inside the first stream's
    # callback. Instead the callback only flips a flag and stops the stream;
    # the heavy lifting runs on the main thread.
    wake_event = threading.Event()
    last_trigger = [0.0]  # mutable for closure

    def audio_callback(indata, frames, time_info, status):
        if status:
            log(f"Audio status: {status}")

        audio = indata[:, 0] if indata.ndim > 1 else indata
        audio_int16 = (audio * 32767).astype(np.int16) if audio.dtype != np.int16 else audio

        predictions = model.predict(audio_int16)
        for wakeword, score in predictions.items():
            if score > WAKE_THRESHOLD:
                now = time.time()
                if now - last_trigger[0] > COOLDOWN_SECONDS:
                    last_trigger[0] = now
                    wake_event.set()
                    raise sd.CallbackStop()

    while True:
        try:
            with sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype=np.int16,
                blocksize=CHUNK_SIZE,
                callback=audio_callback,
            ):
                # Park here until the callback flags a wake or the stream errors.
                while not wake_event.is_set():
                    sd.sleep(100)
            # Stream is now closed (context-manager exit). Safe to record.
            wake_event.clear()
            on_wake_detected()
            # brief pause prevents immediate re-trigger from our own playback tail
            time.sleep(0.5)
        except KeyboardInterrupt:
            log("Stopped by user")
            break
        except Exception as e:
            msg = str(e).lower()
            log(f"Stream error: {e}")
            # PaMacCore -50 (paramErr) and friends typically fire when the
            # default input device disappears mid-stream — most often an
            # AirPods reconnect. Drop the cached silence gate so the new
            # device gets recalibrated when the wake-restart-then-record
            # cycle runs again.
            device_change_tokens = (
                "pamaccore", "paramerr", "-50",
                "device unavailable", "device disconnected", "device lost",
                "invalidproperty", "format not supported",
                "unanticipated host error",
                "errno 19",  # ENODEV
            )
            if any(tok in msg for tok in device_change_tokens):
                reset_silence_gate_cache()
            wake_event.clear()
            time.sleep(2)
            continue

if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    main()
