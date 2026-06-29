from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.core.config import get_settings
from app.services.errors import ServiceError


@dataclass(frozen=True)
class DeepgramTranscript:
    transcript: str
    confidence: float | None
    request_id: str | None
    model: str
    raw: dict[str, Any]


class DeepgramTranscriptionService:
    def __init__(self) -> None:
        self.settings = get_settings()

    def transcribe_wav(self, path: Path) -> DeepgramTranscript:
        if not self.settings.deepgram_api_key:
            raise ServiceError("Deepgram API key is not configured", status_code=422)
        if not path.is_file():
            raise ServiceError("Audio file not found for Deepgram transcription", status_code=404)

        params = {
            "model": self.settings.deepgram_model,
            "smart_format": "true",
        }
        headers = {
            "Authorization": f"Token {self.settings.deepgram_api_key}",
            "Content-Type": "audio/wav",
        }
        try:
            with path.open("rb") as audio_file:
                response = httpx.post(
                    self.settings.deepgram_api_url,
                    params=params,
                    headers=headers,
                    content=audio_file,
                    timeout=self.settings.deepgram_timeout_seconds,
                )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            message = self._deepgram_error_message(exc.response)
            raise ServiceError(f"Deepgram transcription failed: {message}", status_code=502) from exc
        except httpx.HTTPError as exc:
            raise ServiceError("Deepgram transcription request failed", status_code=502) from exc
        except OSError as exc:
            raise ServiceError("Unable to read audio file for Deepgram transcription", status_code=507) from exc

        try:
            payload = response.json()
        except ValueError as exc:
            raise ServiceError("Deepgram returned an unreadable response", status_code=502) from exc
        alternative = self._best_alternative(payload)
        transcript = str(alternative.get("transcript") or "").strip()
        confidence = alternative.get("confidence")
        return DeepgramTranscript(
            transcript=transcript,
            confidence=float(confidence) if isinstance(confidence, int | float) else None,
            request_id=str(payload.get("request_id") or "") or None,
            model=self.settings.deepgram_model,
            raw=payload,
        )

    def _best_alternative(self, payload: dict[str, Any]) -> dict[str, Any]:
        channels = payload.get("results", {}).get("channels", [])
        if not channels:
            return {}
        alternatives = channels[0].get("alternatives", [])
        if not alternatives:
            return {}
        return alternatives[0] if isinstance(alternatives[0], dict) else {}

    def _deepgram_error_message(self, response: httpx.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            return response.text[:300] or response.reason_phrase
        for key in ("err_msg", "message", "error"):
            value = payload.get(key)
            if value:
                return str(value)
        return response.reason_phrase
