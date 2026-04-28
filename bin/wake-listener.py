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
import re
import sys
import time
import json
import select
import subprocess
import tempfile
import signal
import threading
import importlib.util
import collections
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

# Pre-wake ring buffer: keeps the last ~1.44s of audio that streamed past the
# wake-word callback so record_command can recover the first syllable of the
# command, which would otherwise be clipped while the wake stream is being
# torn down and the recording stream opened.
RING_BUFFER_CHUNKS = 18  # 18 * 80ms = 1.44s
RING_BUFFER_ENABLED = os.environ.get("JARVIS_RING_BUFFER", "1") == "1"
_ring_buffer: collections.deque = collections.deque(maxlen=RING_BUFFER_CHUNKS)
_ring_lock = threading.Lock()

# End-of-speech silence gate (seconds of below-threshold audio before we stop
# recording). The previous hardcoded 1.5s added 700ms of dead air per turn
# beyond what users actually need to finish a sentence. 0.8s is conservative
# enough to avoid clipping mid-thought while still feeling responsive.
try:
    VOICE_SILENCE_S = float(os.environ.get("JARVIS_VOICE_SILENCE_S", "0.8"))
except ValueError:
    VOICE_SILENCE_S = 0.8

# Continuous conversation mode: after the first wake-triggered turn, stay open
# for follow-up utterances without requiring a fresh "Hey Jarvis." Listens via
# VAD on a fresh InputStream and uses the same silence gate. Exits on idle
# timeout or an explicit exit phrase ("goodbye", "thanks Jarvis", etc.).
CONVO_MODE_ENABLED = os.environ.get("JARVIS_CONVO_MODE", "1") == "1"
try:
    CONVO_TIMEOUT_S = float(os.environ.get("JARVIS_CONVO_TIMEOUT", "30"))
except ValueError:
    CONVO_TIMEOUT_S = 30.0

# State files —
#   convo_active   touched while a convo session is running (any kind), so
#                  jarvis-notify can decide whether to deliver immediately
#                  or queue for later
#   convo_mode     persistent toggle ("1" or "0"). When "1", wake-word
#                  detection is skipped and the listener goes straight into
#                  conversation mode each loop iteration. The state survives
#                  process restarts and can be read by other scripts.
STATE_DIR = ASSISTANT_DIR / "state"
CONVO_FLAG = STATE_DIR / "convo_active"
CONVO_PERSIST_FLAG = STATE_DIR / "convo_mode"

# Notification queue — pending.json is a JSON array of {message, ts} entries
# written by jarvis-notify when convo is active. We pop+deliver from rest
# moments (between wake cycles, and during convo idle waits).
NOTIF_DIR = ASSISTANT_DIR / "notifications"
PENDING_NOTIFICATIONS = NOTIF_DIR / "pending.json"
NOTIFICATION_POLL_S = 5.0  # how often to drain the queue during idle waits

# Voice-activated mode toggle. Detected after transcription, before sending
# to Claude — works regardless of STT backend. Anchored at start of utterance
# so e.g. "I told her goodbye" doesn't deactivate.
_ACTIVATE_RE = re.compile(
    r'^\s*('
    r'i\'?m\s+working'
    r'|work\s+mode'
    r'|stay\s+on'
    r')\b',
    re.I,
)
_DEACTIVATE_RE = re.compile(
    r'^\s*('
    r'that\'?s\s+all'
    r'|take\s+a\s+break'
    r'|go\s+to\s+sleep'
    r'|goodbye'
    r'|good\s+bye'
    r'|that\s+will\s+be\s+all'
    r'|bye[\s,.!]+jarvis'
    r')\b',
    re.I,
)

ACTIVATE_REPLY = "I'm here. Just talk whenever you need me."
DEACTIVATE_REPLY = "I'll be listening for my name."

# Speculative generation — fires Claude during user speech against partial
# transcripts (only Deepgram emits partials; whisper users get a silent no-op).
# Default: enabled when JARVIS_STT=deepgram, disabled otherwise.
def _speculation_default() -> str:
    return "1" if os.environ.get("JARVIS_STT") == "deepgram" else "0"
SPECULATE_ENABLED = os.environ.get("JARVIS_SPECULATE", _speculation_default()) == "1"

# Voice fingerprinting — only respond to Watson's voice. Default: enabled
# whenever a voiceprint exists. The verify() helper handles missing
# resemblyzer / missing enrollment gracefully (returns None → fail open).
VOICEPRINT_FILE = ASSISTANT_DIR / "voiceprint.npy"


def _voice_id_default() -> str:
    return "1" if VOICEPRINT_FILE.exists() else "0"
VOICE_ID_ENABLED = os.environ.get("JARVIS_VOICE_ID", _voice_id_default()) == "1"
_voiceprint_mod = None


def _load_voiceprint_module():
    global _voiceprint_mod
    if _voiceprint_mod is not None:
        return _voiceprint_mod
    src = BIN_DIR / "jarvis-voiceprint.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_voiceprint", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _voiceprint_mod = mod
        return mod
    except Exception as e:
        log(f"voiceprint module load failed: {e}")
        return None


_ambient_mod = None


def _load_ambient_module():
    """Lazy-load bin/jarvis-ambient.py for the scene classifier."""
    global _ambient_mod
    if _ambient_mod is not None:
        return _ambient_mod
    src = BIN_DIR / "jarvis-ambient.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_ambient", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _ambient_mod = mod
        return mod
    except Exception as e:
        log(f"ambient module load failed: {e}")
        return None


def _voice_matches_owner(audio_path: str) -> bool:
    """Verify the captured audio against the enrolled voiceprint.

    Returns True (allow turn) when:
      - Voice ID gate is disabled
      - No enrollment exists (fail open)
      - resemblyzer is missing (fail open)
      - Score >= threshold

    Returns False only when an enrolled voiceprint is on disk AND the score
    falls below the threshold — that's the only signal we can act on.
    """
    if not VOICE_ID_ENABLED:
        return True
    mod = _load_voiceprint_module()
    if mod is None:
        return True
    try:
        score = mod.verify(audio_path)
    except Exception as e:
        log(f"voiceprint verify error: {e}")
        return True
    if score is None:
        return True  # no enrollment or library missing — back-compat
    threshold = mod.VOICE_THRESHOLD
    matched = score >= threshold
    log(f"voiceprint score={score:.3f} threshold={threshold:.2f} match={matched}")
    return matched


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

    Side effect: when JARVIS_AMBIENT=1, classifies the captured audio into
    a scene label (quiet_office / noisy_environment / car / meeting) and
    writes it to ~/.jarvis/state/ambient_scene for downstream consumers
    (jarvis-context.py, bin/jarvis volume adjust).
    """
    chunks_needed = max(4, int(duration_seconds * SAMPLE_RATE / CHUNK_SIZE))
    amps = []
    raw_chunks = []
    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype=np.int16,
            blocksize=CHUNK_SIZE,
        ) as stream:
            for _ in range(chunks_needed):
                chunk, _ = stream.read(CHUNK_SIZE)
                flat = chunk.flatten()
                amps.append(float(np.abs(flat).mean()))
                raw_chunks.append(flat.copy())
    except Exception as e:
        log(f"Noise calibration failed ({e}); using fallback gate {NOISE_GATE_FALLBACK}")
        return NOISE_GATE_FALLBACK

    if not amps:
        return NOISE_GATE_FALLBACK

    noise_floor = float(np.percentile(amps, NOISE_PERCENTILE))
    gate = int(max(NOISE_GATE_FLOOR, min(NOISE_GATE_CEILING, noise_floor * NOISE_GATE_MULTIPLIER)))
    log(f"Noise floor p{NOISE_PERCENTILE}={noise_floor:.0f} → silence gate={gate}")

    # Reuse the calibration audio for ambient scene classification — free
    # since we already captured it. Failures are non-fatal: we just don't
    # write the state file and downstream consumers fall back to defaults.
    if os.environ.get("JARVIS_AMBIENT", "1") == "1":
        try:
            ambient_mod = _load_ambient_module()
            if ambient_mod is not None:
                label, metrics = ambient_mod.classify(raw_chunks)
                ambient_mod.write_scene(label, metrics)
                log(f"Ambient scene: {label} (rms={metrics.get('rms')} centroid={metrics.get('centroid_hz')} zcr={metrics.get('zcr')})")
        except Exception as e:
            log(f"ambient classify skipped: {e}")

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
def record_command(max_seconds=15, silence_seconds=VOICE_SILENCE_S):
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
        # Recover audio that streamed past the wake-word callback before this
        # InputStream opened — typically the wake word itself plus the first
        # syllable of the command.
        if RING_BUFFER_ENABLED:
            with _ring_lock:
                prebuf = list(_ring_buffer)
                _ring_buffer.clear()
            if prebuf:
                log(f"Prepending {len(prebuf)} ring-buffer chunks ({len(prebuf) * 80}ms lookback)")
                audio_chunks.extend(prebuf)
                started_speaking = True
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

# ─── Streaming STT (Deepgram) ─────────────────────────────────────────
# Opt-in via JARVIS_STT=deepgram. The streaming binary handles its own
# audio capture, WebSocket, VAD, and timeouts — we just wait for a single
# line of FINAL transcript on stdout. Anything else (no key, network
# failure, no speech) → return None and let the caller fall back to whisper.
STREAM_STT_TIMEOUT = 20  # seconds; covers ONCE_OVERALL_TIMEOUT + slack

def transcribe_streaming():
    """Run jarvis-listen-stream --once. Returns transcript string or None."""
    if os.environ.get("JARVIS_STT") != "deepgram":
        return None

    stream_bin = BIN_DIR / "jarvis-listen-stream"
    if not stream_bin.exists():
        log("Deepgram requested but jarvis-listen-stream not found")
        return None

    env = os.environ.copy()
    env["JARVIS_STT"] = "deepgram"

    try:
        result = subprocess.run(
            [str(stream_bin), "--once"],
            env=env,
            capture_output=True,
            text=True,
            timeout=STREAM_STT_TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired:
        log("Deepgram subprocess timed out — falling back to whisper")
        return None
    except Exception as e:
        log(f"Deepgram subprocess failed ({e}) — falling back to whisper")
        return None

    if result.returncode != 0:
        # stderr already explains why; the streamer logs the specific reason
        err = (result.stderr or "").strip().splitlines()
        last = err[-1] if err else f"rc={result.returncode}"
        log(f"Deepgram failed ({last}) — falling back to whisper")
        return None

    transcript = (result.stdout or "").strip()
    if not transcript:
        log("Deepgram returned empty transcript — falling back to whisper")
        return None

    return transcript


# ─── Conversation-mode state file ────────────────────────────────────
def _set_convo_flag(active: bool) -> None:
    """Touch / remove the convo_active state file. Best-effort — failures
    just mean jarvis-notify can't tell whether to queue, in which case it
    falls back to immediate delivery."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        if active:
            CONVO_FLAG.touch()
        else:
            try:
                CONVO_FLAG.unlink()
            except FileNotFoundError:
                pass
    except Exception as e:
        log(f"convo flag toggle failed: {e}")


def _is_activate_phrase(text: str) -> bool:
    return bool(_ACTIVATE_RE.match((text or "").strip()))


def _is_deactivate_phrase(text: str) -> bool:
    return bool(_DEACTIVATE_RE.match((text or "").strip()))


def _set_persistent_convo(active: bool) -> None:
    """Write the persistent convo-mode flag to disk. Survives process
    restart so a subsequent launch enters convo mode immediately."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        CONVO_PERSIST_FLAG.write_text("1" if active else "0", encoding="utf-8")
    except Exception as e:
        log(f"persistent convo flag write failed: {e}")


def _is_persistent_convo_active() -> bool:
    try:
        return CONVO_PERSIST_FLAG.read_text(encoding="utf-8").strip() == "1"
    except (FileNotFoundError, OSError):
        return False


def _handle_special_phrases(user_text: str) -> str | None:
    """If user_text triggers a mode change, set state + speak ack.
    Returns 'activate' / 'deactivate' / None.

    Detected post-transcription so it works with any STT backend (whisper,
    Deepgram, future). Caller decides what to do with the action — typically
    skip sending to Claude (this IS the response)."""
    if _is_activate_phrase(user_text):
        log("Activate phrase detected — persistent convo mode ON")
        _set_persistent_convo(True)
        speak(ACTIVATE_REPLY)
        return "activate"
    if _is_deactivate_phrase(user_text):
        log("Deactivate phrase detected — persistent convo mode OFF")
        _set_persistent_convo(False)
        speak(DEACTIVATE_REPLY)
        return "deactivate"
    return None


# ─── Notification queue (drained at idle moments) ─────────────────────
def _deliver_one_pending_notification() -> bool:
    """Pop one message from pending.json and deliver via `jarvis-notify --force`.
    Returns True if something was delivered. Best-effort — on any IO/JSON error
    we leave the queue alone for the next attempt."""
    if not PENDING_NOTIFICATIONS.exists():
        return False
    try:
        with PENDING_NOTIFICATIONS.open("r", encoding="utf-8") as f:
            queue = json.load(f)
    except (json.JSONDecodeError, OSError):
        return False
    if not isinstance(queue, list) or not queue:
        return False

    notif = queue.pop(0)
    try:
        with PENDING_NOTIFICATIONS.open("w", encoding="utf-8") as f:
            json.dump(queue, f, indent=2)
    except OSError:
        return False

    msg = notif.get("message", "") if isinstance(notif, dict) else str(notif)
    if not msg:
        return False

    notify_bin = BIN_DIR / "jarvis-notify"
    if not notify_bin.exists():
        log("pending notification dropped — jarvis-notify not installed")
        return False

    log(f"delivering pending notification: {msg[:60]}")
    try:
        subprocess.run(
            [str(notify_bin), "--force", msg],
            timeout=30,
            check=False,
            capture_output=True,
        )
    except Exception as e:
        log(f"jarvis-notify failed: {e}")
    return True


def _drain_pending_notifications(limit: int = 5) -> None:
    """Deliver up to `limit` queued notifications back-to-back. Bounded so a
    runaway queue can't pin the loop forever."""
    for _ in range(limit):
        if not _deliver_one_pending_notification():
            return


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
def on_wake_detected() -> str | None:
    """Triggered when 'Hey Jarvis' is detected. Returns:
        'activate'   — user said an activation phrase (caller enters
                       persistent convo mode)
        'deactivate' — user said a deactivation phrase (caller stays
                       in wake-only mode, does not enter session convo)
        None         — normal turn (caller may enter session convo if
                       JARVIS_CONVO_MODE=1)
    """
    log("WAKE WORD DETECTED")

    # Acknowledge
    play_chime()
    # Could also: speak("Sir?") — but chime is faster and less annoying

    user_text = None

    # Streaming STT path — opt-in via JARVIS_STT=deepgram. Captures audio
    # internally and returns the transcript directly; if it fails for any
    # reason (no key, network error, no speech detected) we fall through
    # to the whisper path below so the voice loop never breaks.
    if os.environ.get("JARVIS_STT") == "deepgram":
        user_text = transcribe_streaming()
        if user_text:
            log(f"Deepgram transcript: {user_text}")

    # Whisper fallback (also the default when JARVIS_STT is unset)
    if not user_text:
        audio_path = record_command()
        if not audio_path:
            log("No command recorded")
            return None

        # Voice fingerprint check — only the whisper path exposes the raw
        # WAV. Deepgram streams audio internally and we'd need to fork the
        # streamer to fingerprint it. Fail open when no enrollment exists.
        if not _voice_matches_owner(audio_path):
            log("Voice mismatch — ignoring this turn")
            try:
                os.unlink(audio_path)
            except Exception:
                pass
            return None

        user_text = transcribe(audio_path)
        try:
            os.unlink(audio_path)
        except Exception:
            pass

    if not user_text:
        log("No transcription")
        speak("I did not catch that, sir.")
        return None

    log(f"User said: {user_text}")

    # Special phrases first — these set persistent state + speak their own
    # response. Don't forward to Claude.
    action = _handle_special_phrases(user_text)
    if action:
        return action

    # Process and respond
    respond(user_text)
    return None

# ─── Speculative generation (Innovation 1+3) ──────────────────────────
# Lazy-loaded so non-Deepgram installs don't pay the import cost. The module
# lives at bin/jarvis-speculate.py and provides a Speculator class that fires
# a cheap Haiku call during user speech against partial transcripts.
_speculate_mod = None


def _load_speculator():
    global _speculate_mod
    if _speculate_mod is not None:
        return _speculate_mod
    src = BIN_DIR / "jarvis-speculate.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_speculate", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _speculate_mod = mod
        return mod
    except Exception as e:
        log(f"speculator import failed: {e}")
        return None


def _read_personality_text() -> str:
    try:
        p = ASSISTANT_DIR / "config" / "personality.md"
        return p.read_text(encoding="utf-8") if p.exists() else ""
    except Exception:
        return ""


def _read_history_messages() -> list[dict]:
    history_file = ASSISTANT_DIR / "cache" / "conversation.json"
    if not history_file.exists():
        return []
    try:
        with history_file.open() as f:
            data = json.load(f)
    except Exception:
        return []
    if isinstance(data, list):
        return [m for m in data if m.get("role") in ("user", "assistant")]
    if isinstance(data, dict):
        return list(data.get("messages") or [])
    return []


def _speak_speculation_text(text: str) -> None:
    """Pipe speculation text to TTS as a single force-speak. Cache hits
    (pre-warmed phrases) play instantly; cache misses still beat a fresh
    Claude call."""
    if not text:
        return
    jbin = BIN_DIR / "jarvis"
    if not jbin.exists():
        return
    try:
        subprocess.run(
            [str(jbin), "--speak", text],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=60, check=False,
        )
    except Exception as e:
        log(f"speculation TTS failed: {e}")


def _record_speculative_turn(user_text: str, assistant_text: str) -> None:
    """Drive a no-API-call jarvis-think.py via JARVIS_PREBAKED_RESPONSE so
    history + the rolling summary stay coherent. We can't just append to
    conversation.json directly because jarvis-think.py owns the format."""
    converse_bin = BIN_DIR / "jarvis-converse"
    if not converse_bin.exists():
        log("can't record speculative turn — jarvis-converse missing")
        return
    env = os.environ.copy()
    env["JARVIS_PREBAKED_RESPONSE"] = assistant_text
    # Tell jarvis-converse not to fire its own TTS — we already spoke.
    env["JARVIS_CONVERSE_SILENT"] = "1"
    try:
        subprocess.run(
            [str(converse_bin), "--text", user_text],
            env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=15, check=False,
        )
    except Exception as e:
        log(f"speculative history record failed: {e}")


def run_deepgram_turn_with_speculation(persistent: bool):
    """One convo turn over Deepgram continuous streaming with speculation.

    Returns one of:
        ("transcript", text)            — got a final transcript, caller
                                          handles special phrases + respond()
        ("speculation_used", text)      — speculator hit; reply already played,
                                          history already recorded
        ("idle", None)                  — idle timeout (only meaningful in
                                          session mode; persistent treats it
                                          as a stream blip and retries)
        ("error", reason)               — streamer or import failure; caller
                                          should fall back to local-VAD path
    """
    stream_bin = BIN_DIR / "jarvis-listen-stream"
    if not stream_bin.exists():
        return ("error", "jarvis-listen-stream missing")

    # Drain any queued notifications before opening the streamer — this is
    # the safest moment (mic isn't open, speakers aren't busy with TTS).
    # Notifications that fire mid-utterance wait at most one turn.
    _drain_pending_notifications()

    speculator_mod = _load_speculator() if SPECULATE_ENABLED else None
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    speculator = None
    if speculator_mod and api_key:
        try:
            speculator = speculator_mod.Speculator(
                api_key=api_key,
                system_text=_read_personality_text(),
                history_messages=_read_history_messages(),
            )
        except Exception as e:
            log(f"speculator init failed: {e}")
            speculator = None

    env = os.environ.copy()
    env["JARVIS_STT"] = "deepgram"

    try:
        proc = subprocess.Popen(
            [str(stream_bin)],
            env=env,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1,
        )
    except Exception as e:
        return ("error", f"streamer spawn failed: {e}")

    deadline = time.monotonic() + (86400.0 if persistent else CONVO_TIMEOUT_S)
    speech_started = False
    speech_ended_at: float | None = None
    final_text: str | None = None

    try:
        while final_text is None:
            if proc.poll() is not None:
                # Streamer died (auth failure, network, etc). Surface so
                # caller can fall back to the local-VAD whisper path.
                return ("error", "streamer exited")

            now = time.monotonic()
            if not speech_started and now > deadline:
                return ("idle", None)
            if speech_ended_at is not None and (now - speech_ended_at) > 1.5:
                # SPEECH_END landed but no FINAL came. Treat as no transcript.
                return ("idle", None)

            ready, _, _ = select.select([proc.stdout], [], [], 0.1)
            if not ready:
                if speculator and speculator.fired:
                    # Periodic notification check while streamer is quiet.
                    pass
                continue

            line = proc.stdout.readline()
            if not line:
                continue
            line = line.rstrip("\n\r")
            if not line:
                continue

            if line.startswith("PARTIAL: "):
                text = line[len("PARTIAL: "):]
                if not speech_started:
                    speech_started = True
                if speculator:
                    speculator.feed_partial(text)
            elif line.startswith("FINAL: "):
                final_text = line[len("FINAL: "):].strip()
                break
            elif line == "SPEECH_END":
                if speech_ended_at is None:
                    speech_ended_at = time.monotonic()
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            try: proc.kill()
            except Exception: pass

    if not final_text:
        return ("idle", None)

    # Check speculation first — if it hit, we skip the real call entirely.
    if speculator:
        used, spec_text = speculator.consume_for_final(final_text)
        if used and spec_text:
            log(f"Speculation HIT (final={final_text[:60]!r})")
            _speak_speculation_text(spec_text)
            _record_speculative_turn(final_text, spec_text)
            return ("speculation_used", spec_text)
        elif speculator.fired:
            log(f"Speculation MISS (final={final_text[:60]!r})")

    return ("transcript", final_text)


# ─── Continuous conversation mode ─────────────────────────────────────
# After a wake-triggered turn, stay open for follow-up utterances without
# requiring "Hey Jarvis" again. Listens via VAD on a fresh InputStream;
# uses the same noise-floor silence gate as record_command. While idle (no
# active speech), pending notifications get drained — so timer alerts that
# fired during the previous turn surface as soon as the user pauses.
def record_with_idle_timeout(idle_timeout: float, max_record: int = 15):
    """Wait up to `idle_timeout` for speech to begin, then record until end-
    of-utterance silence (using VOICE_SILENCE_S). Returns audio_path or None.

    None means: idle timeout expired without speech, OR a failure opened the
    stream. Caller treats both as "convo expired, exit gracefully."

    Drains pending notifications periodically while idle, so a queued timer
    alert reaches the user inside the convo session instead of waiting for
    convo to end.
    """
    silence_amplitude = get_silence_gate()
    chunks_per_second = SAMPLE_RATE // CHUNK_SIZE
    idle_chunks_total = max(1, int(idle_timeout * chunks_per_second))
    silence_threshold_chunks = int(VOICE_SILENCE_S * chunks_per_second)
    max_chunks = max_record * chunks_per_second
    notif_poll_chunks = max(1, int(NOTIFICATION_POLL_S * chunks_per_second))

    audio_chunks: list = []
    silence_chunks = 0
    started_speaking = False

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype=np.int16,
            blocksize=CHUNK_SIZE,
        ) as stream:
            # Phase 1: idle wait — listen for speech onset, drain queue periodically.
            idle_count = 0
            poll_count = 0
            while idle_count < idle_chunks_total:
                chunk, _ = stream.read(CHUNK_SIZE)
                chunk = chunk.flatten()
                amplitude = np.abs(chunk).mean()
                if amplitude > silence_amplitude:
                    audio_chunks.append(chunk)
                    started_speaking = True
                    break
                idle_count += 1
                poll_count += 1
                if poll_count >= notif_poll_chunks:
                    poll_count = 0
                    # Note: delivering a notification here would conflict with
                    # the open input stream (audio bleed). Defer to caller
                    # which closes-and-delivers between turns.
                    if PENDING_NOTIFICATIONS.exists():
                        try:
                            with PENDING_NOTIFICATIONS.open() as f:
                                queue = json.load(f)
                            if isinstance(queue, list) and queue:
                                # Signal "deliver pending" by returning a sentinel
                                # path. Callers detect this and act.
                                return "PENDING_NOTIFICATION"
                        except Exception:
                            pass

            if not started_speaking:
                return None

            # Phase 2: record until silence.
            chunk_count = 1
            while chunk_count < max_chunks:
                chunk, _ = stream.read(CHUNK_SIZE)
                chunk = chunk.flatten()
                audio_chunks.append(chunk)
                amplitude = np.abs(chunk).mean()
                if amplitude > silence_amplitude:
                    silence_chunks = 0
                else:
                    silence_chunks += 1
                    if silence_chunks >= silence_threshold_chunks:
                        log("End of speech (convo)")
                        break
                chunk_count += 1
    except Exception as e:
        log(f"convo stream error: {e}")
        return None

    if not audio_chunks:
        return None

    audio = np.concatenate(audio_chunks)
    tmp_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_file.close()
    import wave
    with wave.open(tmp_file.name, "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio.tobytes())
    return tmp_file.name


def run_conversation_mode(persistent: bool = False) -> None:
    """Loop: wait for next utterance → transcribe → respond → repeat.

    Two flavours:
      - session (persistent=False): exits after JARVIS_CONVO_TIMEOUT seconds
        of silence. Used after a wake-triggered turn when JARVIS_CONVO_MODE=1.
      - persistent (persistent=True): no idle timeout. Only exits on a
        deactivation phrase ("that's all" / "go to sleep" / "goodbye" /
        "take a break"). Activated by saying "I'm working" / "work mode" /
        "stay on" — survives wake-listener restarts via state file.

    Two transports:
      - Deepgram continuous streaming when JARVIS_STT=deepgram. Partial
        transcripts feed the speculator, which fires Claude during user
        speech. On FINAL with >=60% overlap, the speculative response is
        spoken immediately — overlapping STT, thinking, and TTS.
      - Local VAD + whisper as the fallback. No partials → no speculation,
        but the same loop semantics apply.

    History persists across turns automatically — every turn writes through
    jarvis-converse → jarvis-think.py → conversation.json.

    If user says an activation phrase mid-session, we promote to persistent.
    """
    use_deepgram = os.environ.get("JARVIS_STT") == "deepgram"
    flavour = "persistent" if persistent else f"session ({CONVO_TIMEOUT_S:.0f}s idle)"
    transport = "deepgram+speculation" if use_deepgram and SPECULATE_ENABLED else (
        "deepgram" if use_deepgram else "whisper-vad"
    )
    log(f"Entering conversation mode: {flavour}, transport={transport}")
    _set_convo_flag(True)
    try:
        while True:
            user_text: str | None = None

            if use_deepgram:
                kind, payload = run_deepgram_turn_with_speculation(persistent)
                if kind == "speculation_used":
                    # Already spoken + history recorded by the speculator path.
                    # Loop back for next turn.
                    continue
                if kind == "transcript":
                    user_text = payload
                elif kind == "idle":
                    if persistent:
                        log("Persistent convo: deepgram idle, retrying")
                        continue
                    log("Conversation mode: idle timeout, returning to wake")
                    speak("I shall be here, sir.")
                    return
                else:  # "error" — fall through to local-VAD path
                    log(f"Deepgram convo error ({payload}); falling back to whisper VAD")

            if user_text is None:
                # Local-VAD + whisper path. Used when JARVIS_STT != deepgram,
                # or as a fallback when the streamer fails.
                timeout = 86400.0 if persistent else CONVO_TIMEOUT_S
                audio_path = record_with_idle_timeout(timeout)

                if audio_path == "PENDING_NOTIFICATION":
                    _drain_pending_notifications()
                    continue

                if audio_path is None:
                    if persistent:
                        log("Persistent convo: stream returned None, retrying")
                        time.sleep(0.5)
                        continue
                    log("Conversation mode: idle timeout, returning to wake")
                    speak("I shall be here, sir.")
                    return

                user_text = transcribe(audio_path)
                try:
                    os.unlink(audio_path)
                except Exception:
                    pass

            if not user_text:
                log("Conversation mode: empty transcript")
                if persistent:
                    continue
                return

            log(f"User said (convo): {user_text}")

            # Mode-toggle phrases handled first. They speak their own ack.
            action = _handle_special_phrases(user_text)
            if action == "deactivate":
                return
            if action == "activate":
                if not persistent:
                    log("Conversation mode: promoted to persistent")
                persistent = True
                continue

            respond(user_text)
            # Loop back to idle wait. Timer resets per turn.
    finally:
        _set_convo_flag(False)
        # Spawn the self-improvement daemon detached. jarvis-improve
        # orchestrates the six systems (feedback → metacog → autopsy →
        # patterns → skills, plus weekly synthesis + evolution) so the
        # listener returns to wake immediately. Replaces the bare
        # feedback spawn that used to live here.
        if os.environ.get("JARVIS_SELF_IMPROVE", "1") == "1":
            improve_bin = BIN_DIR / "jarvis-improve"
            if improve_bin.exists():
                try:
                    subprocess.Popen(
                        [str(improve_bin)],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                except Exception as e:
                    log(f"jarvis-improve spawn failed: {e}")
            else:
                # Back-compat fallback — direct feedback if the daemon
                # isn't installed.
                fb_bin = BIN_DIR / "jarvis-feedback.py"
                if fb_bin.exists():
                    try:
                        subprocess.Popen(
                            [sys.executable, str(fb_bin)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True,
                        )
                    except Exception as e:
                        log(f"feedback spawn failed: {e}")


# ─── Main loop ────────────────────────────────────────────────────────
def main():
    log(f"JARVIS wake listener starting (assistant: {ASSISTANT_NAME})")
    log(
        "Config: silence_gate=%.2fs ring_buffer=%s convo_mode=%s convo_timeout=%.0fs speculate=%s stt=%s"
        % (VOICE_SILENCE_S, RING_BUFFER_ENABLED, CONVO_MODE_ENABLED,
           CONVO_TIMEOUT_S, SPECULATE_ENABLED, os.environ.get("JARVIS_STT", "whisper"))
    )

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

    # Honor a persistent convo-mode flag carried over from a prior run.
    # Logged once at startup so the boot mode is visible.
    if _is_persistent_convo_active():
        log("Persistent convo flag set on startup")

    # Pre-warm the response audio cache in the background. Common phrases
    # ("Got it.", "Good morning, sir.", etc.) get fetched from ElevenLabs
    # once at boot so subsequent uses play instantly from the local cache.
    # Detached + DEVNULL — we don't block listener startup on it.
    cache_warm_bin = BIN_DIR / "jarvis-cache-warm"
    if cache_warm_bin.exists() and os.environ.get("JARVIS_RESPONSE_CACHE", "1") == "1":
        try:
            subprocess.Popen(
                [str(cache_warm_bin)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            log("Cache pre-warm started (background)")
        except Exception as e:
            log(f"Cache pre-warm failed to spawn: {e}")

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

        # Snapshot every chunk into the ring buffer BEFORE wake processing so
        # record_command can recover audio captured just before/during the
        # wake-word trigger. Copy because PortAudio reuses the indata buffer.
        if RING_BUFFER_ENABLED:
            with _ring_lock:
                _ring_buffer.append(audio_int16.copy())

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
            # Persistent convo mode bypasses wake detection entirely.
            # Re-check every iteration so a deactivation phrase or external
            # write to the state file lands on the next loop turn.
            if _is_persistent_convo_active():
                # Drain any queued notifications before opening the convo
                # stream — keeps timer alerts from getting stuck behind a
                # session that never goes idle long enough to drain.
                _drain_pending_notifications()
                run_conversation_mode(persistent=True)
                # When run_conversation_mode returns, deactivation has
                # cleared the flag. Loop top re-checks and falls through
                # to wake detection.
                time.sleep(0.5)
                continue

            # Pending notifications are also delivered between wake cycles
            # when no convo session is open and nothing's actively listening
            # — the safest moment to bring up the speaker.
            _drain_pending_notifications()

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
            action = on_wake_detected()

            # Decide whether to enter conversation mode after this turn:
            #   action == "activate"   → user asked us to stay on; persistent
            #   action == "deactivate" → user asked us to step back; wake-only
            #   action is None         → normal turn; honor JARVIS_CONVO_MODE
            if action == "activate":
                run_conversation_mode(persistent=True)
            elif action != "deactivate" and CONVO_MODE_ENABLED:
                run_conversation_mode(persistent=False)

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
