#!/usr/bin/env python3
"""Ambient scene classifier — adapt Jarvis to the room.

Analyzes a short window of int16 mono audio captured by wake-listener.py's
existing silence-gate calibration step and labels the environment so the
rest of the stack can adapt:

    quiet_office       baseline; normal behavior
    noisy_environment  louder TTS, shorter responses
    car                hands-free mode, very concise
    meeting            secretary mode (listen, only respond when addressed)

Outputs:
  - ~/.jarvis/state/ambient_scene (single-line label, optionally followed
    by ":<reason>" for debugging) — read by jarvis-context.py and bin/jarvis
    so a single calibration pass propagates everywhere
  - rms / spectral_centroid / zcr / scene metrics on stderr if
    JARVIS_AMBIENT_DEBUG=1

Design intent: simple feature thresholds, no ML model. Calibration audio is
already free; this just runs three numpy ops on it.

Usage in code:
    from jarvis_ambient import classify, write_scene  (via importlib)
    chunks = [...]  # list of int16 numpy arrays from sd.InputStream
    label, metrics = classify(chunks)
    write_scene(label)

Standalone smoke test (synthesized signal):
    python3 bin/jarvis-ambient.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Iterable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
STATE_DIR = ASSISTANT_DIR / "state"
SCENE_FILE = STATE_DIR / "ambient_scene"

SAMPLE_RATE = 16000

# Tunables — chosen to cover typical mac-mic scenarios. Raise/lower via env
# without changing code. Values calibrated against the wake-listener's int16
# RMS readings (running 0–10000 on AirPods at home, ~3000–8000 in a
# coffee-shop, >12000 in a car cabin).
RMS_QUIET = float(os.environ.get("JARVIS_AMBIENT_RMS_QUIET", "1500"))
RMS_NOISY = float(os.environ.get("JARVIS_AMBIENT_RMS_NOISY", "5000"))
RMS_CAR = float(os.environ.get("JARVIS_AMBIENT_RMS_CAR", "10000"))
# Spectral centroid in Hz. Low = bass-dominant (engine, HVAC); high = bright
# (voices, coffee shop chatter). Voices typically peak 1500–3500 Hz.
CENTROID_BASS = float(os.environ.get("JARVIS_AMBIENT_CENTROID_BASS", "1000"))
CENTROID_VOICE = float(os.environ.get("JARVIS_AMBIENT_CENTROID_VOICE", "2500"))
# Zero-crossing rate flags voice presence (~0.05–0.2 for speech, lower for
# tonal noise like fans, higher for hiss).
ZCR_VOICE_LOW = float(os.environ.get("JARVIS_AMBIENT_ZCR_VOICE_LOW", "0.04"))
ZCR_VOICE_HIGH = float(os.environ.get("JARVIS_AMBIENT_ZCR_VOICE_HIGH", "0.20"))


def _features(samples) -> tuple[float, float, float]:
    """Return (rms, spectral_centroid_hz, zcr) for one int16 array."""
    import numpy as np
    arr = samples.astype(np.float32)
    if arr.size == 0:
        return 0.0, 0.0, 0.0

    rms = float(np.sqrt(np.mean(arr * arr)))

    # Zero-crossing rate
    sign_changes = np.sum(np.abs(np.diff(np.signbit(arr).astype(np.int8))))
    zcr = float(sign_changes) / max(1, arr.size - 1)

    # Spectral centroid via rfft
    if arr.size >= 64:
        spectrum = np.abs(np.fft.rfft(arr * np.hanning(arr.size)))
        freqs = np.fft.rfftfreq(arr.size, 1.0 / SAMPLE_RATE)
        spec_sum = spectrum.sum()
        centroid = float((spectrum * freqs).sum() / spec_sum) if spec_sum > 0 else 0.0
    else:
        centroid = 0.0
    return rms, centroid, zcr


def classify(chunks: Iterable) -> tuple[str, dict]:
    """Classify scene from a list of int16 sample arrays.

    Returns (label, metrics_dict) where metrics is the averaged feature
    triple (handy for debug/logging). Label ∈ {quiet_office,
    noisy_environment, car, meeting}.
    """
    try:
        import numpy as np
    except ImportError:
        return "quiet_office", {"error": "numpy missing"}

    samples_list = [np.asarray(c).flatten() for c in chunks if c is not None]
    samples_list = [s for s in samples_list if s.size > 0]
    if not samples_list:
        return "quiet_office", {"reason": "no audio"}

    audio = np.concatenate(samples_list)
    rms, centroid, zcr = _features(audio)

    # Variance across chunks distinguishes meeting (multiple voices, varying
    # RMS over time) from steady noise (car, fan, fridge).
    rms_values = [_features(s)[0] for s in samples_list]
    rms_var = float(np.var(rms_values)) if len(rms_values) > 1 else 0.0
    rms_mean = float(np.mean(rms_values)) if rms_values else 0.0

    metrics = {
        "rms": round(rms, 1),
        "rms_mean": round(rms_mean, 1),
        "rms_var": round(rms_var, 1),
        "centroid_hz": round(centroid, 1),
        "zcr": round(zcr, 4),
    }

    # Decision tree:
    #   - Loud + low centroid + steady → car cabin
    #   - Loud + voice-band centroid + high variance → meeting
    #   - Loud (other) → noisy_environment
    #   - Quiet → quiet_office
    voice_band = CENTROID_BASS <= centroid <= 6000
    voice_zcr = ZCR_VOICE_LOW <= zcr <= ZCR_VOICE_HIGH

    if rms >= RMS_CAR and centroid < CENTROID_BASS:
        label = "car"
    elif rms >= RMS_NOISY and voice_band and voice_zcr and rms_var > (rms_mean * 0.4) ** 2:
        label = "meeting"
    elif rms >= RMS_NOISY:
        label = "noisy_environment"
    else:
        label = "quiet_office"

    metrics["label"] = label
    return label, metrics


SCENE_HINTS = {
    "quiet_office": "Environment: quiet. Normal cadence and length.",
    "noisy_environment": "Environment: noisy. Keep responses brief and clear; the user may struggle to hear long answers.",
    "car": "Environment: car / hands-free. Very concise; one fact per turn. No long lists.",
    "meeting": "Environment: meeting in progress. Listen mode — only respond if the user addressed you by name. Default to silence.",
}

SCENE_TTS_VOLUME = {
    "quiet_office": "0.7",
    "noisy_environment": "1.0",
    "car": "1.0",
    "meeting": "0.5",
}


def write_scene(label: str, metrics: dict | None = None) -> None:
    """Write the scene label to ~/.jarvis/state/ambient_scene. Best-effort."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        line = label
        if metrics:
            # Keep it grep-able but informative.
            extras = " ".join(
                f"{k}={metrics[k]}" for k in ("rms", "centroid_hz", "zcr") if k in metrics
            )
            if extras:
                line = f"{label}\t{extras}"
        SCENE_FILE.write_text(line + "\n", encoding="utf-8")
    except OSError as e:
        sys.stderr.write(f"jarvis-ambient: write failed ({e})\n")


def read_scene() -> str:
    """Return the current scene label, or 'quiet_office' if none is set or
    the file is unreadable."""
    try:
        first = SCENE_FILE.read_text(encoding="utf-8").splitlines()[0]
    except (FileNotFoundError, OSError, IndexError):
        return "quiet_office"
    return first.split("\t", 1)[0].strip() or "quiet_office"


def hint_for(label: str) -> str:
    return SCENE_HINTS.get(label, SCENE_HINTS["quiet_office"])


def tts_volume_for(label: str) -> str:
    return SCENE_TTS_VOLUME.get(label, SCENE_TTS_VOLUME["quiet_office"])


def _smoke() -> int:
    try:
        import numpy as np
    except ImportError:
        print("numpy missing")
        return 1
    rng = np.random.default_rng(0)
    quiet = (rng.normal(0, 200, SAMPLE_RATE).astype(np.int16),)
    noisy = (rng.normal(0, 6000, SAMPLE_RATE).astype(np.int16),)
    car_sig = (rng.normal(0, 12000, SAMPLE_RATE).astype(np.int16)
               * (np.sin(2 * np.pi * 80 * np.arange(SAMPLE_RATE) / SAMPLE_RATE)).astype(np.int16),)
    for name, audio in [("quiet", quiet), ("noisy", noisy), ("car-ish", car_sig)]:
        label, m = classify(audio)
        print(f"{name:8s} → {label}  ({m})")
    return 0


if __name__ == "__main__":
    sys.exit(_smoke())
