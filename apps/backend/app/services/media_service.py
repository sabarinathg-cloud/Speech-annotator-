import mimetypes
import hashlib
import os
import tempfile
import wave
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

EXPLICIT_AUDIO_MEDIA_TYPES = {
    ".opus": "audio/ogg",
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
        media_type = self._audio_media_type(location.key or file_location)
        return StreamingResponse(stream, media_type=media_type, headers=SECURE_AUDIO_HEADERS)

    def build_combined_wav_response(self, file_locations: list[str], range_header: str | None = None):
        if not file_locations:
            raise ServiceError("No audio chunks are available for this recording", status_code=404)

        paths: list[Path] = []
        for file_location in file_locations:
            location = self.audio_resolver.resolve(file_location)
            if location.scheme != "local" or not location.local_path:
                raise ServiceError("Full audio playback is only available for local WAV chunks", status_code=422)
            path = Path(location.local_path).expanduser()
            if path.suffix.lower() != ".wav":
                raise ServiceError("Full audio playback requires WAV chunks", status_code=422)
            if not path.is_file():
                raise FileNotFoundError("Audio chunk not found")
            paths.append(path)

        cache_path = self._combined_wav_cache_path(paths)
        if not cache_path.is_file():
            self._write_combined_wav(paths, cache_path)
        return self._build_local_audio_response(cache_path, range_header)

    def _build_local_audio_response(self, path: Path, range_header: str | None):
        if not path.is_file():
            raise FileNotFoundError("Audio file not found")

        file_size = path.stat().st_size
        media_type = self._audio_media_type(str(path))
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

    def _audio_media_type(self, filename: str) -> str:
        suffix = Path(filename).suffix.lower()
        return EXPLICIT_AUDIO_MEDIA_TYPES.get(suffix) or mimetypes.guess_type(filename)[0] or "application/octet-stream"

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

    def _combined_wav_cache_path(self, paths: list[Path]) -> Path:
        digest = hashlib.sha256()
        for path in paths:
            stat = path.stat()
            digest.update(str(path.resolve()).encode("utf-8"))
            digest.update(str(stat.st_size).encode("ascii"))
            digest.update(str(stat.st_mtime_ns).encode("ascii"))
        cache_dir = settings.upload_path / "audio-groups"
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir / f"{digest.hexdigest()}.wav"

    def _write_combined_wav(self, paths: list[Path], cache_path: Path) -> None:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_fd, tmp_name = tempfile.mkstemp(prefix=f"{cache_path.stem}.", suffix=".tmp", dir=cache_path.parent)
        os.close(tmp_fd)
        tmp_path = Path(tmp_name)
        try:
            params = None
            with wave.open(str(tmp_path), "wb") as output:
                for path in paths:
                    try:
                        with wave.open(str(path), "rb") as source:
                            source_params = source.getparams()
                            comparable = (
                                source_params.nchannels,
                                source_params.sampwidth,
                                source_params.framerate,
                                source_params.comptype,
                            )
                            if params is None:
                                params = comparable
                                output.setnchannels(source_params.nchannels)
                                output.setsampwidth(source_params.sampwidth)
                                output.setframerate(source_params.framerate)
                            elif comparable != params:
                                raise ServiceError(
                                    "Audio chunks use different WAV formats and cannot be combined safely",
                                    status_code=422,
                                )
                            if source_params.comptype != "NONE":
                                raise ServiceError("Compressed WAV chunks cannot be combined safely", status_code=422)
                            while True:
                                data = source.readframes(65536)
                                if not data:
                                    break
                                output.writeframesraw(data)
                    except wave.Error as exc:
                        raise ServiceError("Could not read one of the WAV chunks", status_code=422) from exc
            tmp_path.replace(cache_path)
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise
