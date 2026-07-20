import hashlib
import json
import math
import re
import shutil
import tempfile
import wave
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, cast

from app.core.config import get_settings
from app.models.task import AnnotationTask
from app.services.errors import ServiceError
from app.storage.audio_resolver import AudioResolver

settings = get_settings()

ALIGNMENT_MODEL_NAME = "torchaudio.WAV2VEC2_ASR_BASE_960H"
MASK_PADDING_SECONDS = 0.08
MASK_MIN_DURATION_SECONDS = 0.25
ALIGNMENT_ENERGY_MARGIN_SECONDS = 0.025
ALIGNMENT_ENERGY_SEARCH_PADDING_SECONDS = 0.12
ALIGNMENT_ENERGY_FRAME_SECONDS = 0.02
ALIGNMENT_ENERGY_HOP_SECONDS = 0.01
ALIGNMENT_ENERGY_THRESHOLD_RATIO = 0.12
ALIGNMENT_MIN_WORD_SECONDS = 0.04
BEEP_FREQUENCY_HZ = 1000.0
BEEP_VOLUME_RATIO = 0.35
AudioMaskMode = Literal["silence", "beep"]
DIGIT_WORDS_UPPER = {
    "0": "ZERO",
    "1": "ONE",
    "2": "TWO",
    "3": "THREE",
    "4": "FOUR",
    "5": "FIVE",
    "6": "SIX",
    "7": "SEVEN",
    "8": "EIGHT",
    "9": "NINE",
}


@dataclass(frozen=True)
class TranscriptWord:
    index: int
    text: str
    normalized_text: str
    start_char: int
    end_char: int


@dataclass(frozen=True)
class AlignedWord:
    index: int
    text: str
    normalized_text: str
    start_char: int
    end_char: int
    start_seconds: float
    end_seconds: float
    score: float | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "text": self.text,
            "normalized_text": self.normalized_text,
            "start_char": self.start_char,
            "end_char": self.end_char,
            "start_seconds": round(self.start_seconds, 3),
            "end_seconds": round(self.end_seconds, 3),
            "score": round(self.score, 4) if self.score is not None else None,
        }


@dataclass(frozen=True)
class MaskInterval:
    start_seconds: float
    end_seconds: float
    labels: list[str]
    text: str
    id: str | None = None
    source_annotation_ids: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "start_seconds": round(self.start_seconds, 3),
            "end_seconds": round(self.end_seconds, 3),
            "labels": self.labels,
            "text": self.text,
        }
        if self.id is not None:
            payload["id"] = self.id
        if self.source_annotation_ids is not None:
            payload["source_annotation_ids"] = self.source_annotation_ids
        return payload


@dataclass(frozen=True)
class _Point:
    token_index: int
    time_index: int
    score: float


@dataclass(frozen=True)
class _Segment:
    label: str
    start: int
    end: int
    score: float

    @property
    def length(self) -> int:
        return self.end - self.start


_MODEL_CACHE: dict[str, Any] = {}


def transcript_hash(transcript: str) -> str:
    return hashlib.sha256(transcript.encode("utf-8")).hexdigest()


def normalize_audio_mask_mode(mask_mode: str) -> AudioMaskMode:
    if mask_mode not in {"silence", "beep"}:
        raise ServiceError("Audio mask mode must be either silence or beep", status_code=422)
    return cast(AudioMaskMode, mask_mode)


def pii_hash(
    pii_annotations: list[dict[str, Any]],
    mask_mode: AudioMaskMode = "silence",
    mask_intervals: list[dict[str, Any]] | None = None,
) -> str:
    normalized = [
        {
            "label": str(item.get("label") or ""),
            "start": int(item.get("start") or 0),
            "end": int(item.get("end") or 0),
            "value": str(item.get("value") or ""),
        }
        for item in pii_annotations
    ]
    normalized.sort(key=lambda item: (item["start"], item["end"], item["label"], item["value"]))
    normalized_intervals = None
    if mask_intervals is not None:
        normalized_intervals = [
            {
                "start_seconds": round(float(item.get("start_seconds") or 0), 3),
                "end_seconds": round(float(item.get("end_seconds") or 0), 3),
                "labels": [str(label) for label in item.get("labels", [])],
                "text": str(item.get("text") or ""),
                "id": str(item.get("id")) if item.get("id") is not None else None,
                "source_annotation_ids": [
                    str(annotation_id) for annotation_id in (item.get("source_annotation_ids") or [])
                ],
            }
            for item in mask_intervals
        ]
        normalized_intervals.sort(key=lambda item: (item["start_seconds"], item["end_seconds"], item["labels"], item["text"]))
    payload = {"annotations": normalized, "mask_intervals": normalized_intervals, "mask_mode": mask_mode}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def _silence_pcm_frame(sample_width: int, channels: int) -> bytes:
    if sample_width == 1:
        return bytes([128] * channels)
    return b"\x00" * sample_width * channels


def _beep_pcm_frame(frame_index: int, frame_rate: int, sample_width: int, channels: int) -> bytes:
    if frame_rate <= 0:
        return _silence_pcm_frame(sample_width, channels)
    max_value = (2 ** (sample_width * 8 - 1)) - 1
    amplitude = max_value * BEEP_VOLUME_RATIO
    value = int(amplitude * math.sin(2 * math.pi * BEEP_FREQUENCY_HZ * frame_index / frame_rate))
    sample = _pack_pcm_sample(value, sample_width)
    return sample * channels


def _pack_pcm_sample(value: int, sample_width: int) -> bytes:
    if sample_width == 1:
        unsigned_value = max(0, min(255, value + 128))
        return bytes([unsigned_value])
    min_value = -(2 ** (sample_width * 8 - 1))
    max_value = (2 ** (sample_width * 8 - 1)) - 1
    clamped = max(min_value, min(max_value, value))
    return int(clamped).to_bytes(sample_width, byteorder="little", signed=True)


def tokenize_transcript_words(transcript: str) -> list[TranscriptWord]:
    words: list[TranscriptWord] = []
    for match in re.finditer(r"\S+", transcript):
        text = match.group(0)
        if any(char.isdigit() for char in text):
            for unit in re.finditer(r"\d|[^\d\s]+", text):
                unit_text = unit.group(0)
                unit_start = match.start() + unit.start()
                unit_end = match.start() + unit.end()
                normalized = DIGIT_WORDS_UPPER[unit_text] if unit_text.isdigit() else normalize_alignment_word(unit_text)
                if not normalized:
                    continue
                words.append(
                    TranscriptWord(
                        index=len(words),
                        text=unit_text,
                        normalized_text=normalized,
                        start_char=unit_start,
                        end_char=unit_end,
                    )
                )
            continue

        normalized = normalize_alignment_word(text)
        if normalized:
            words.append(
                TranscriptWord(
                    index=len(words),
                    text=text,
                    normalized_text=normalized,
                    start_char=match.start(),
                    end_char=match.end(),
                )
            )
    return words


def normalize_alignment_word(text: str) -> str:
    return re.sub(r"[^A-Z']", "", text.upper())


def build_mask_intervals(
    words: list[dict[str, Any]],
    pii_annotations: list[dict[str, Any]],
    *,
    audio_duration: float | None = None,
    padding_seconds: float = MASK_PADDING_SECONDS,
) -> list[MaskInterval]:
    raw_intervals: list[MaskInterval] = []

    for annotation in pii_annotations:
        annotation_start = int(annotation.get("start") or 0)
        annotation_end = int(annotation.get("end") or 0)
        annotation_id = str(annotation.get("id") or f"{annotation_start}:{annotation_end}:{annotation.get('label') or 'PII'}")
        matched_words = [
            word
            for word in words
            if int(word.get("start_char") or 0) < annotation_end and annotation_start < int(word.get("end_char") or 0)
        ]
        if not matched_words:
            continue

        start_seconds = min(float(word["start_seconds"]) for word in matched_words) - padding_seconds
        end_seconds = max(float(word["end_seconds"]) for word in matched_words) + padding_seconds
        if audio_duration is not None:
            start_seconds = max(0.0, min(start_seconds, audio_duration))
            end_seconds = max(0.0, min(end_seconds, audio_duration))
        else:
            start_seconds = max(0.0, start_seconds)
        if end_seconds <= start_seconds:
            continue
        if end_seconds - start_seconds < MASK_MIN_DURATION_SECONDS:
            midpoint = (start_seconds + end_seconds) / 2
            start_seconds = midpoint - MASK_MIN_DURATION_SECONDS / 2
            end_seconds = midpoint + MASK_MIN_DURATION_SECONDS / 2
            if audio_duration is not None:
                if start_seconds < 0:
                    end_seconds = min(audio_duration, end_seconds - start_seconds)
                    start_seconds = 0.0
                if end_seconds > audio_duration:
                    start_seconds = max(0.0, start_seconds - (end_seconds - audio_duration))
                    end_seconds = audio_duration
            else:
                if start_seconds < 0:
                    end_seconds -= start_seconds
                    start_seconds = 0.0

        raw_intervals.append(
            MaskInterval(
                start_seconds=start_seconds,
                end_seconds=end_seconds,
                labels=[str(annotation.get("label") or "PII")],
                text=" ".join(str(word.get("text") or "") for word in matched_words).strip(),
                id=annotation_id,
                source_annotation_ids=[annotation_id],
            )
        )

    return merge_mask_intervals(raw_intervals)


def merge_mask_intervals(intervals: list[MaskInterval]) -> list[MaskInterval]:
    if not intervals:
        return []

    sorted_intervals = sorted(intervals, key=lambda item: (item.start_seconds, item.end_seconds))
    merged: list[MaskInterval] = [sorted_intervals[0]]
    for interval in sorted_intervals[1:]:
        previous = merged[-1]
        if interval.start_seconds <= previous.end_seconds:
            labels = sorted({*previous.labels, *interval.labels})
            text_parts = [part for part in [previous.text, interval.text] if part]
            source_annotation_ids = sorted(
                {
                    *(previous.source_annotation_ids or ([previous.id] if previous.id else [])),
                    *(interval.source_annotation_ids or ([interval.id] if interval.id else [])),
                }
            )
            merged[-1] = MaskInterval(
                start_seconds=previous.start_seconds,
                end_seconds=max(previous.end_seconds, interval.end_seconds),
                labels=labels,
                text=" / ".join(dict.fromkeys(text_parts)),
                id=source_annotation_ids[0] if len(source_annotation_ids) == 1 else f"mask:{'+'.join(source_annotation_ids)}",
                source_annotation_ids=source_annotation_ids,
            )
        else:
            merged.append(interval)
    return merged


class AudioAlignmentService:
    def __init__(self) -> None:
        self.audio_resolver = AudioResolver()

    def align_task_audio(self, task: AnnotationTask, *, force: bool = False) -> list[dict[str, Any]]:
        transcript = task.final_transcript or ""
        current_hash = transcript_hash(transcript)
        if (
            not force
            and task.alignment_words
            and task.alignment_transcript_hash == current_hash
            and task.alignment_model == ALIGNMENT_MODEL_NAME
        ):
            return task.alignment_words

        words = tokenize_transcript_words(transcript)
        if not words:
            raise ServiceError("Final transcript has no alignable words", status_code=422)

        aligned_words = self._run_wav2vec_alignment(task.file_location, words)
        if not aligned_words:
            raise ServiceError("Forced alignment produced no word timings", status_code=422)

        task.alignment_words = [word.to_dict() for word in aligned_words]
        task.alignment_transcript_hash = current_hash
        task.alignment_model = ALIGNMENT_MODEL_NAME
        task.alignment_updated_at = datetime.now(timezone.utc)
        return task.alignment_words

    def build_pii_masked_audio(
        self,
        task: AnnotationTask,
        *,
        force: bool = False,
        mask_mode: str = "silence",
        custom_intervals: list[dict[str, Any]] | None = None,
    ) -> tuple[str, list[dict[str, Any]]]:
        normalized_mask_mode = normalize_audio_mask_mode(mask_mode)
        if not task.pii_annotations and custom_intervals is None:
            raise ServiceError("No PII annotations are available to mask", status_code=422)

        if task.pii_annotations:
            words = self.align_task_audio(task, force=force)
        else:
            words = task.alignment_words or []
        current_pii_hash = pii_hash(task.pii_annotations or [], normalized_mask_mode, custom_intervals)
        if (
            not force
            and task.masked_audio_location
            and task.masked_audio_pii_hash == current_pii_hash
            and Path(task.masked_audio_location).is_file()
        ):
            reference_intervals = build_mask_intervals(words, task.pii_annotations or []) if task.pii_annotations else []
            intervals = (
                self._custom_mask_intervals(custom_intervals)
                if custom_intervals is not None
                else reference_intervals
            )
            accepted_reference_intervals = intervals if custom_intervals is not None else reference_intervals
            self._store_mask_metadata(
                task,
                intervals,
                accepted_reference_intervals,
                reference_intervals,
                normalized_mask_mode,
            )
            return task.masked_audio_location, [interval.to_dict() for interval in intervals]

        with self._materialized_audio_path(task.file_location) as source_path:
            duration = self._get_audio_duration(source_path)
            reference_intervals = (
                build_mask_intervals(words, task.pii_annotations or [], audio_duration=duration)
                if task.pii_annotations
                else []
            )
            intervals = (
                self._custom_mask_intervals(custom_intervals, audio_duration=duration)
                if custom_intervals is not None
                else reference_intervals
            )
            if not intervals:
                raise ServiceError("PII annotations could not be mapped to aligned audio words", status_code=422)

            output_path = self._masked_audio_path(task.id, current_pii_hash)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            self._write_masked_audio(source_path, output_path, intervals, mask_mode=normalized_mask_mode)

        task.masked_audio_location = str(output_path)
        task.masked_audio_pii_hash = current_pii_hash
        task.masked_audio_updated_at = datetime.now(timezone.utc)
        accepted_reference_intervals = intervals if custom_intervals is not None else reference_intervals
        self._store_mask_metadata(
            task,
            intervals,
            accepted_reference_intervals,
            reference_intervals,
            normalized_mask_mode,
        )
        return str(output_path), [interval.to_dict() for interval in intervals]

    def _store_mask_metadata(
        self,
        task: AnnotationTask,
        intervals: list[MaskInterval],
        reference_intervals: list[MaskInterval],
        alignment_intervals: list[MaskInterval],
        mask_mode: AudioMaskMode,
    ) -> None:
        task.masked_audio_intervals = [interval.to_dict() for interval in intervals]
        task.masked_audio_reference_intervals = [interval.to_dict() for interval in reference_intervals]
        task.masked_audio_alignment_intervals = [interval.to_dict() for interval in alignment_intervals]
        task.masked_audio_mode = mask_mode

    def _custom_mask_intervals(
        self,
        custom_intervals: list[dict[str, Any]] | None,
        *,
        audio_duration: float | None = None,
    ) -> list[MaskInterval]:
        if not custom_intervals:
            raise ServiceError("At least one mask interval is required", status_code=422)

        intervals: list[MaskInterval] = []
        for item in custom_intervals:
            start_seconds = max(0.0, float(item.get("start_seconds") or 0.0))
            end_seconds = max(0.0, float(item.get("end_seconds") or 0.0))
            if audio_duration is not None:
                start_seconds = min(start_seconds, audio_duration)
                end_seconds = min(end_seconds, audio_duration)
            if end_seconds <= start_seconds:
                raise ServiceError("Mask interval end time must be greater than start time", status_code=422)
            labels = [str(label) for label in item.get("labels", []) if str(label)]
            source_annotation_ids = [str(annotation_id) for annotation_id in (item.get("source_annotation_ids") or [])]
            intervals.append(
                MaskInterval(
                    start_seconds=start_seconds,
                    end_seconds=end_seconds,
                    labels=labels,
                    text=str(item.get("text") or ""),
                    id=str(item.get("id")) if item.get("id") is not None else None,
                    source_annotation_ids=source_annotation_ids or None,
                )
            )
        return sorted(intervals, key=lambda interval: (interval.start_seconds, interval.end_seconds, interval.text))

    def _run_wav2vec_alignment(self, file_location: str, words: list[TranscriptWord]) -> list[AlignedWord]:
        torch, torchaudio = self._load_torch_audio()
        bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
        labels = bundle.get_labels()
        dictionary = {label: index for index, label in enumerate(labels)}
        full_transcript = "|" + "|".join(word.normalized_text for word in words) + "|"
        compact_transcript = "|" + "".join(word.normalized_text for word in words)
        missing = sorted({char for char in full_transcript if char not in dictionary})
        if missing:
            raise ServiceError(
                "Transcript contains characters unsupported by the alignment model",
                status_code=422,
                extra={"unsupported_characters": missing},
            )

        model = self._get_model(bundle)
        device = next(model.parameters()).device

        with self._materialized_audio_path(file_location) as audio_path:
            waveform, sample_rate = self._load_waveform(audio_path, torch, torchaudio)

        if waveform.size(0) > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        if sample_rate != bundle.sample_rate:
            waveform = torchaudio.functional.resample(waveform, sample_rate, bundle.sample_rate)
            sample_rate = bundle.sample_rate

        with torch.inference_mode():
            emissions, _ = model(waveform.to(device))
            emissions = torch.log_softmax(emissions, dim=-1)
        emission = emissions[0].cpu()

        transcript = full_transcript
        tokens = [dictionary[char] for char in transcript]
        compact_alignment = False
        if len(tokens) > emission.size(0):
            compact_tokens = [dictionary[char] for char in compact_transcript]
            if len(compact_tokens) > emission.size(0):
                raise ServiceError(
                    "Transcript is too long for this audio to force-align. Check that the transcript matches the audio.",
                    status_code=422,
                    extra={"alignment_tokens": len(tokens), "audio_frames": emission.size(0)},
                )
            transcript = compact_transcript
            tokens = compact_tokens
            compact_alignment = True

        trellis = _get_trellis(torch, emission, tokens, blank_id=0)
        path = _backtrack(emission, trellis, tokens, blank_id=0)
        token_segments = _merge_repeats(path, transcript)
        word_segments = _merge_compact_words(token_segments, words) if compact_alignment else _merge_words(token_segments)

        if len(word_segments) != len(words):
            raise ServiceError(
                "Forced alignment word count did not match transcript words",
                status_code=422,
                extra={"expected_words": len(words), "aligned_words": len(word_segments)},
            )

        samples_per_frame = waveform.size(1) / emission.size(0)
        aligned: list[AlignedWord] = []
        for word, segment in zip(words, word_segments, strict=True):
            start_seconds = (segment.start * samples_per_frame) / sample_rate
            end_seconds = (segment.end * samples_per_frame) / sample_rate
            aligned.append(
                AlignedWord(
                    index=word.index,
                    text=word.text,
                    normalized_text=word.normalized_text,
                    start_char=word.start_char,
                    end_char=word.end_char,
                    start_seconds=start_seconds,
                    end_seconds=end_seconds,
                    score=segment.score,
                )
            )
        return _refine_aligned_word_boundaries(aligned, waveform[0].cpu(), sample_rate)

    def _load_torch_audio(self):
        try:
            import torch
            import torchaudio
        except ImportError as exc:
            raise ServiceError(
                "Forced alignment is not installed. Rebuild the backend with torch and torchaudio dependencies.",
                status_code=503,
            ) from exc
        return torch, torchaudio

    def _get_model(self, bundle):
        import torch

        if "model" not in _MODEL_CACHE:
            device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            model = bundle.get_model().to(device)
            model.eval()
            _MODEL_CACHE["model"] = model
        return _MODEL_CACHE["model"]

    def _load_waveform(self, path: Path, torch, torchaudio):
        if path.suffix.lower() == ".wav":
            try:
                return self._load_wav_with_stdlib(path, torch)
            except (EOFError, ValueError, wave.Error):
                # Fall through to torchaudio for uncommon WAV encodings when a decoder is available.
                pass

        try:
            return torchaudio.load(str(path))
        except Exception as exc:
            raise ServiceError(
                "Audio decoding failed. Upload a PCM WAV file or configure TorchCodec/FFmpeg support for this audio format.",
                status_code=422,
            ) from exc

    def _load_wav_with_stdlib(self, path: Path, torch):
        with wave.open(str(path), "rb") as wav_file:
            channels = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            sample_rate = wav_file.getframerate()
            frame_count = wav_file.getnframes()
            compression = wav_file.getcomptype()
            frames = wav_file.readframes(frame_count)

        if compression != "NONE":
            raise ValueError("Compressed WAV files require an audio decoder")
        if channels <= 0 or sample_rate <= 0:
            raise ValueError("Invalid WAV channel or sample rate")

        buffer = bytearray(frames)
        if sample_width == 1:
            samples = torch.frombuffer(buffer, dtype=torch.uint8).to(torch.float32)
            samples = (samples - 128.0) / 128.0
        elif sample_width == 2:
            samples = torch.frombuffer(buffer, dtype=torch.int16).to(torch.float32) / 32768.0
        elif sample_width == 3:
            values = []
            for offset in range(0, len(buffer), 3):
                raw_value = int.from_bytes(buffer[offset : offset + 3], byteorder="little", signed=False)
                if raw_value & 0x800000:
                    raw_value -= 0x1000000
                values.append(raw_value / 8388608.0)
            samples = torch.tensor(values, dtype=torch.float32)
        elif sample_width == 4:
            samples = torch.frombuffer(buffer, dtype=torch.int32).to(torch.float32) / 2147483648.0
        else:
            raise ValueError("Unsupported WAV sample width")

        if samples.numel() % channels != 0:
            raise ValueError("WAV sample count is not divisible by channel count")
        waveform = samples.reshape(-1, channels).transpose(0, 1).contiguous()
        return waveform, sample_rate

    def _materialized_audio_path(self, file_location: str):
        location = self.audio_resolver.resolve(file_location)
        if location.scheme == "local" and location.local_path:
            path = Path(location.local_path).expanduser()
            if not path.is_file():
                raise ServiceError("Audio file not found", status_code=404)
            return _ExistingPathContext(path)

        suffix = Path(location.key or "audio.wav").suffix or ".wav"
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        temp_path = Path(temp_file.name)
        try:
            with temp_file:
                source = self.audio_resolver.open_audio(location)
                try:
                    shutil.copyfileobj(source, temp_file)
                finally:
                    source.close()
            return _TemporaryPathContext(temp_path)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

    def _get_audio_duration(self, path: Path) -> float | None:
        if path.suffix.lower() == ".wav":
            try:
                with wave.open(str(path), "rb") as wav_file:
                    return wav_file.getnframes() / float(wav_file.getframerate())
            except wave.Error:
                return None
        try:
            torch, torchaudio = self._load_torch_audio()
            info = torchaudio.info(str(path))
            return info.num_frames / float(info.sample_rate) if info.sample_rate else None
        except ServiceError:
            return None

    def _masked_audio_path(self, task_id: str, current_pii_hash: str) -> Path:
        return settings.upload_path / "masked-audio" / f"{task_id}-{current_pii_hash[:16]}.wav"

    def _write_masked_audio(
        self,
        source_path: Path,
        output_path: Path,
        intervals: list[MaskInterval],
        *,
        mask_mode: str = "silence",
    ) -> None:
        normalized_mask_mode = normalize_audio_mask_mode(mask_mode)
        if source_path.suffix.lower() == ".wav" and self._try_mask_wav_file(
            source_path,
            output_path,
            intervals,
            mask_mode=normalized_mask_mode,
        ):
            return
        self._mask_with_torchaudio(source_path, output_path, intervals, mask_mode=normalized_mask_mode)

    def _try_mask_wav_file(
        self,
        source_path: Path,
        output_path: Path,
        intervals: list[MaskInterval],
        *,
        mask_mode: str = "silence",
    ) -> bool:
        normalized_mask_mode = normalize_audio_mask_mode(mask_mode)
        try:
            with wave.open(str(source_path), "rb") as reader:
                params = reader.getparams()
                frames = bytearray(reader.readframes(reader.getnframes()))
                frame_rate = reader.getframerate()
                sample_width = reader.getsampwidth()
                channels = reader.getnchannels()
                frame_width = sample_width * channels
                for interval in intervals:
                    start_frame = max(0, int(math.floor(interval.start_seconds * frame_rate)))
                    end_frame = min(params.nframes, int(math.ceil(interval.end_seconds * frame_rate)))
                    for frame_index in range(start_frame, end_frame):
                        offset = frame_index * frame_width
                        if normalized_mask_mode == "beep":
                            frames[offset : offset + frame_width] = _beep_pcm_frame(
                                frame_index,
                                frame_rate,
                                sample_width,
                                channels,
                            )
                        else:
                            frames[offset : offset + frame_width] = _silence_pcm_frame(sample_width, channels)
            with wave.open(str(output_path), "wb") as writer:
                writer.setparams(params)
                writer.writeframes(bytes(frames))
            return True
        except wave.Error:
            return False

    def _mask_with_torchaudio(
        self,
        source_path: Path,
        output_path: Path,
        intervals: list[MaskInterval],
        *,
        mask_mode: str = "silence",
    ) -> None:
        normalized_mask_mode = normalize_audio_mask_mode(mask_mode)
        torch, torchaudio = self._load_torch_audio()
        waveform, sample_rate = torchaudio.load(str(source_path))
        masked = waveform.clone()
        total_samples = masked.size(1)
        for interval in intervals:
            start_sample = max(0, min(total_samples, int(math.floor(interval.start_seconds * sample_rate))))
            end_sample = max(start_sample, min(total_samples, int(math.ceil(interval.end_seconds * sample_rate))))
            if normalized_mask_mode == "beep":
                sample_count = end_sample - start_sample
                if sample_count > 0:
                    t = torch.arange(sample_count, device=masked.device, dtype=masked.dtype) / float(sample_rate)
                    tone = torch.sin(2 * math.pi * BEEP_FREQUENCY_HZ * t) * BEEP_VOLUME_RATIO
                    masked[:, start_sample:end_sample] = tone.expand(masked.size(0), sample_count)
            else:
                masked[:, start_sample:end_sample] = 0
        torchaudio.save(str(output_path), masked.cpu(), sample_rate)


class _ExistingPathContext:
    def __init__(self, path: Path):
        self.path = path

    def __enter__(self) -> Path:
        return self.path

    def __exit__(self, exc_type, exc, tb) -> None:
        return None


class _TemporaryPathContext:
    def __init__(self, path: Path):
        self.path = path

    def __enter__(self) -> Path:
        return self.path

    def __exit__(self, exc_type, exc, tb) -> None:
        self.path.unlink(missing_ok=True)


def _get_trellis(torch, emission, tokens: list[int], blank_id: int = 0):
    num_frame = emission.size(0)
    num_tokens = len(tokens)
    trellis = torch.zeros((num_frame, num_tokens))
    trellis[1:, 0] = torch.cumsum(emission[1:, blank_id], 0)
    trellis[0, 1:] = -float("inf")
    trellis[-num_tokens + 1 :, 0] = float("inf")
    for time_index in range(num_frame - 1):
        trellis[time_index + 1, 1:] = torch.maximum(
            trellis[time_index, 1:] + emission[time_index, blank_id],
            trellis[time_index, :-1] + emission[time_index, tokens[1:]],
        )
    return trellis


def _backtrack(emission, trellis, tokens: list[int], blank_id: int = 0) -> list[_Point]:
    time_index = trellis.size(0) - 1
    token_index = trellis.size(1) - 1
    path = [_Point(token_index, time_index, emission[time_index, blank_id].exp().item())]
    while token_index > 0:
        if time_index <= 0:
            raise ServiceError("Forced alignment could not backtrack through the transcript", status_code=422)
        stay_score = emission[time_index - 1, blank_id]
        change_score = emission[time_index - 1, tokens[token_index]]
        stayed = trellis[time_index - 1, token_index] + stay_score
        changed = trellis[time_index - 1, token_index - 1] + change_score
        time_index -= 1
        changed_token = changed > stayed
        if changed_token:
            token_index -= 1
        probability = (change_score if changed_token else stay_score).exp().item()
        path.append(_Point(token_index, time_index, probability))

    while time_index > 0:
        probability = emission[time_index - 1, blank_id].exp().item()
        path.append(_Point(token_index, time_index - 1, probability))
        time_index -= 1

    return path[::-1]


def _merge_repeats(path: list[_Point], transcript: str) -> list[_Segment]:
    index = 0
    segments: list[_Segment] = []
    while index < len(path):
        end_index = index
        while end_index < len(path) and path[index].token_index == path[end_index].token_index:
            end_index += 1
        score = sum(path[item].score for item in range(index, end_index)) / (end_index - index)
        segments.append(
            _Segment(
                label=transcript[path[index].token_index],
                start=path[index].time_index,
                end=path[end_index - 1].time_index + 1,
                score=score,
            )
        )
        index = end_index
    return segments


def _merge_words(segments: list[_Segment], separator: str = "|") -> list[_Segment]:
    words: list[_Segment] = []
    start_index = 0
    end_index = 0
    while start_index < len(segments):
        if end_index >= len(segments) or segments[end_index].label == separator:
            if start_index != end_index:
                word_segments = segments[start_index:end_index]
                word = "".join(segment.label for segment in word_segments)
                total_length = sum(segment.length for segment in word_segments)
                score = sum(segment.score * segment.length for segment in word_segments) / total_length
                words.append(_Segment(word, segments[start_index].start, segments[end_index - 1].end, score))
            start_index = end_index + 1
            end_index = start_index
        else:
            end_index += 1
    return words


def _merge_compact_words(
    segments: list[_Segment],
    transcript_words: list[TranscriptWord],
    separator: str = "|",
) -> list[_Segment]:
    character_segments = [segment for segment in segments if segment.label != separator]
    words: list[_Segment] = []
    start_index = 0
    for transcript_word in transcript_words:
        end_index = start_index + len(transcript_word.normalized_text)
        word_segments = character_segments[start_index:end_index]
        if len(word_segments) != len(transcript_word.normalized_text):
            raise ServiceError("Forced alignment produced incomplete word timings", status_code=422)
        total_length = sum(segment.length for segment in word_segments)
        if total_length <= 0:
            raise ServiceError("Forced alignment produced zero-length word timings", status_code=422)
        score = sum(segment.score * segment.length for segment in word_segments) / total_length
        words.append(
            _Segment(
                label="".join(segment.label for segment in word_segments),
                start=word_segments[0].start,
                end=word_segments[-1].end,
                score=score,
            )
        )
        start_index = end_index

    if start_index != len(character_segments):
        raise ServiceError("Forced alignment produced extra character timings", status_code=422)
    return words


def _refine_aligned_word_boundaries(
    words: list[AlignedWord],
    waveform,
    sample_rate: int,
) -> list[AlignedWord]:
    if not words or sample_rate <= 0:
        return words

    audio = waveform.detach().cpu()
    if audio.dim() > 1:
        audio = audio.mean(dim=0)
    if audio.numel() == 0:
        return words

    duration_seconds = audio.numel() / float(sample_rate)
    refined: list[AlignedWord] = []
    for index, word in enumerate(words):
        raw_start = max(0.0, min(word.start_seconds, duration_seconds))
        raw_end = max(raw_start, min(word.end_seconds, duration_seconds))
        search_start = max(0.0, raw_start - ALIGNMENT_ENERGY_SEARCH_PADDING_SECONDS)
        search_end = min(duration_seconds, raw_end + ALIGNMENT_ENERGY_SEARCH_PADDING_SECONDS)

        if index > 0:
            previous = words[index - 1]
            if previous.end_seconds < raw_start:
                search_start = max(search_start, (previous.end_seconds + raw_start) / 2)
            else:
                search_start = max(search_start, raw_start)
        if index + 1 < len(words):
            next_word = words[index + 1]
            if raw_end < next_word.start_seconds:
                search_end = min(search_end, (raw_end + next_word.start_seconds) / 2)
            else:
                search_end = min(search_end, raw_end)

        energy_span = _find_local_energy_span(audio, sample_rate, search_start, search_end)
        if energy_span is None:
            refined.append(word)
            continue

        energy_start, energy_end = energy_span
        start_seconds = max(search_start, energy_start - ALIGNMENT_ENERGY_MARGIN_SECONDS)
        end_seconds = min(search_end, energy_end + ALIGNMENT_ENERGY_MARGIN_SECONDS)
        if end_seconds - start_seconds < ALIGNMENT_MIN_WORD_SECONDS:
            refined.append(word)
            continue
        refined.append(replace(word, start_seconds=start_seconds, end_seconds=end_seconds))

    return _enforce_monotonic_word_boundaries(refined)


def _find_local_energy_span(waveform, sample_rate: int, start_seconds: float, end_seconds: float) -> tuple[float, float] | None:
    start_sample = max(0, int(math.floor(start_seconds * sample_rate)))
    end_sample = min(waveform.numel(), int(math.ceil(end_seconds * sample_rate)))
    if end_sample <= start_sample:
        return None

    segment = waveform[start_sample:end_sample].abs()
    if segment.numel() == 0:
        return None

    frame_size = max(1, int(round(ALIGNMENT_ENERGY_FRAME_SECONDS * sample_rate)))
    hop_size = max(1, int(round(ALIGNMENT_ENERGY_HOP_SECONDS * sample_rate)))
    if segment.numel() < frame_size:
        peak = float(segment.max().item())
        return (start_seconds, end_seconds) if peak > 0 else None

    frames = segment.unfold(0, frame_size, hop_size)
    rms = (frames.pow(2).mean(dim=1)).sqrt()
    peak = float(rms.max().item())
    if peak <= 0:
        return None

    threshold = max(peak * ALIGNMENT_ENERGY_THRESHOLD_RATIO, 0.0025)
    active = (rms >= threshold).nonzero(as_tuple=False).flatten()
    if active.numel() == 0:
        return None

    first_frame = int(active[0].item())
    last_frame = int(active[-1].item())
    energy_start = (start_sample + first_frame * hop_size) / float(sample_rate)
    energy_end = (start_sample + last_frame * hop_size + frame_size) / float(sample_rate)
    return energy_start, min(end_seconds, energy_end)


def _enforce_monotonic_word_boundaries(words: list[AlignedWord]) -> list[AlignedWord]:
    if len(words) < 2:
        return words

    adjusted = list(words)
    for index in range(len(adjusted) - 1):
        current = adjusted[index]
        next_word = adjusted[index + 1]
        if current.end_seconds <= next_word.start_seconds:
            continue
        midpoint = (current.end_seconds + next_word.start_seconds) / 2
        adjusted[index] = replace(current, end_seconds=max(current.start_seconds, midpoint))
        adjusted[index + 1] = replace(next_word, start_seconds=min(next_word.end_seconds, midpoint))
    return adjusted
