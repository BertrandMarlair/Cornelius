"""Cornelius local voice sidecar: speech-to-text (faster-whisper) and text-to-speech (Piper).

Runs on the CPU so the graphics card stays free for games. Listens on 127.0.0.1 only.
  POST /stt  body = mono PCM16 16 kHz  -> {"text": "..."}
  POST /tts  {"text": "..."}           -> mono PCM16 16 kHz
  GET  /health
"""
import io
import json
import os
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

HOST = os.environ.get("CORNELIUS_VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("CORNELIUS_VOICE_PORT", "8765"))
STT_MODEL = os.environ.get("CORNELIUS_STT_MODEL", "large-v3-turbo")
STT_THREADS = int(os.environ.get("CORNELIUS_STT_THREADS", "6"))
VOICE_PATH = os.environ.get("CORNELIUS_TTS_VOICE", "")
IDLE_UNLOAD_S = int(os.environ.get("CORNELIUS_VOICE_IDLE_UNLOAD", "600"))

_lock = threading.Lock()
_stt = None
_tts = None
_last_use = time.time()


def stt_model():
    global _stt
    if _stt is None:
        from faster_whisper import WhisperModel

        _stt = WhisperModel(STT_MODEL, device="cpu", compute_type="int8", cpu_threads=STT_THREADS)
    return _stt


def tts_voice():
    global _tts
    if _tts is None:
        from piper import PiperVoice

        _tts = PiperVoice.load(VOICE_PATH)
    return _tts


def resample(samples: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst or len(samples) == 0:
        return samples
    n = int(round(len(samples) * dst / src))
    x = np.linspace(0, len(samples) - 1, n)
    return np.interp(x, np.arange(len(samples)), samples)


def transcribe(pcm: bytes) -> str:
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    if audio.size < 1600:
        return ""
    segments, _ = stt_model().transcribe(
        audio,
        language="fr",
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
        initial_prompt="Cornelius, la maison, allume, éteins, la lumière.",
    )
    return " ".join(s.text.strip() for s in segments).strip()


def synthesize(text: str) -> bytes:
    voice = tts_voice()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        voice.synthesize_wav(text, wav)
    buf.seek(0)
    with wave.open(buf, "rb") as wav:
        rate = wav.getframerate()
        frames = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32)
    out = resample(frames, rate, 16000)
    return np.clip(out, -32768, 32767).astype(np.int16).tobytes()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, json.dumps({"ok": True, "stt": _stt is not None, "tts": _tts is not None}).encode())
        else:
            self._send(404, b"{}")

    def do_POST(self):
        global _last_use
        length = int(self.headers.get("Content-Length", "0"))
        if length > 16 * 1024 * 1024:
            self._send(413, b"{}")
            return
        body = self.rfile.read(length)
        try:
            with _lock:
                _last_use = time.time()
                if self.path == "/stt":
                    self._send(200, json.dumps({"text": transcribe(body)}, ensure_ascii=False).encode())
                elif self.path == "/tts":
                    text = str(json.loads(body or b"{}").get("text", ""))[:2000]
                    self._send(200, synthesize(text) if text.strip() else b"", "application/octet-stream")
                elif self.path == "/warmup":
                    stt_model(); tts_voice()
                    self._send(200, b'{"ok":true}')
                else:
                    self._send(404, b"{}")
        except Exception as error:  # noqa: BLE001 - report to the caller, keep serving
            self._send(500, json.dumps({"error": str(error)}).encode())


def unloader():
    """Free the RAM when nobody has talked for a while."""
    global _stt, _tts
    while True:
        time.sleep(30)
        with _lock:
            if (_stt or _tts) and time.time() - _last_use > IDLE_UNLOAD_S:
                _stt = None
                _tts = None
                import gc

                gc.collect()


if __name__ == "__main__":
    threading.Thread(target=unloader, daemon=True).start()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
