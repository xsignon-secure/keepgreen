"""Records the ad's voiceover from scripts/ad-script.json into scripts/voice/sN.m4a.

Uses Kokoro (Apache-2.0), a small open text-to-speech model that runs on the CPU:

    python3 -m venv .venv && .venv/bin/pip install kokoro-onnx soundfile
    # model files: https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0
    .venv/bin/python scripts/voiceover.py <folder with kokoro-v1.0.onnx and voices-v1.0.bin> [voice]

The default voice is af_heart. ffmpeg must be on PATH. Then run node scripts/gen-ad.mjs.
"""

import json
import os
import subprocess
import sys
import tempfile

import soundfile as sf
from kokoro_onnx import Kokoro

here = os.path.dirname(os.path.abspath(__file__))
models = sys.argv[1]
voice = sys.argv[2] if len(sys.argv) > 2 else "af_heart"
kokoro = Kokoro(os.path.join(models, "kokoro-v1.0.onnx"), os.path.join(models, "voices-v1.0.bin"))
out = os.path.join(here, "voice")
os.makedirs(out, exist_ok=True)

for scene in json.load(open(os.path.join(here, "ad-script.json"), encoding="utf-8")):
    audio, rate = kokoro.create(scene["say"], voice=voice, speed=1.05, lang="en-us")
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "line.wav")
        sf.write(wav, audio, rate)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "aac", "-b:a", "96k", os.path.join(out, scene["id"] + ".m4a")], check=True)
    print(f"{scene['id']}: {len(audio) / rate:.2f}s")
