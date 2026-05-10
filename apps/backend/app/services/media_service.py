import mimetypes
from pathlib import Path

from fastapi.responses import FileResponse, Response, StreamingResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.core.config import get_settings
from app.services.errors import ServiceError
from app.storage.audio_resolver import AudioResolver

settings = get_settings()


SECURE_AUDIO_HEADERS = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store, max-age=0",
    "Content-Disposition": "inline",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}


class MediaService:
    def __init__(self) -> None:
        self.serializer = URLSafeTimedSerializer(settings.audio_signing_secret)
        self.audio_resolver = AudioResolver()

    def decode_audio_token(self, token: str) -> dict:
        try:
            return self.serializer.loads(token, max_age=settings.audio_signing_expire_seconds)
        except SignatureExpired as exc:
            raise ServiceError("Audio URL has expired", status_code=401) from exc
        except BadSignature as exc:
            raise ServiceError("Invalid audio token", status_code=401) from exc

    def open_audio_stream(self, file_location: str):
        location = self.audio_resolver.resolve(file_location)
        return self.audio_resolver.open_audio(location)

    def build_audio_response(self, file_location: str, range_header: str | None = None):
        location = self.audio_resolver.resolve(file_location)
        if location.scheme == "local" and location.local_path:
            return self._build_local_audio_response(Path(location.local_path).expanduser(), range_header)

        stream = self.audio_resolver.open_audio(location)
        media_type = mimetypes.guess_type(location.key or file_location)[0] or "application/octet-stream"
        return StreamingResponse(stream, media_type=media_type, headers=SECURE_AUDIO_HEADERS)

    def _build_local_audio_response(self, path: Path, range_header: str | None):
        if not path.is_file():
            raise FileNotFoundError("Audio file not found")

        file_size = path.stat().st_size
        media_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        headers = dict(SECURE_AUDIO_HEADERS)
        if not range_header:
            return FileResponse(path, media_type=media_type, headers=headers)

        start, end = self._parse_range_header(range_header, file_size)
        content_length = end - start + 1
        with path.open("rb") as audio_file:
            audio_file.seek(start)
            content = audio_file.read(content_length)

        headers.update(
            {
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(content_length),
            }
        )
        return Response(content=content, status_code=206, media_type=media_type, headers=headers)

    def _parse_range_header(self, range_header: str, file_size: int) -> tuple[int, int]:
        if not range_header.startswith("bytes="):
            raise ServiceError("Invalid audio range", status_code=416)
        raw_range = range_header.removeprefix("bytes=").strip()
        if "," in raw_range or "-" not in raw_range:
            raise ServiceError("Invalid audio range", status_code=416)

        raw_start, raw_end = raw_range.split("-", 1)
        if raw_start == "":
            try:
                suffix_length = int(raw_end)
            except ValueError as exc:
                raise ServiceError("Invalid audio range", status_code=416) from exc
            if suffix_length <= 0:
                raise ServiceError("Invalid audio range", status_code=416)
            start = max(file_size - suffix_length, 0)
            end = file_size - 1
        else:
            try:
                start = int(raw_start)
                end = int(raw_end) if raw_end else file_size - 1
            except ValueError as exc:
                raise ServiceError("Invalid audio range", status_code=416) from exc

        if start < 0 or start >= file_size or end < start:
            raise ServiceError("Invalid audio range", status_code=416)
        return start, min(end, file_size - 1)
