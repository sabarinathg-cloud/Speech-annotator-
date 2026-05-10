import math
import struct
import wave
from types import SimpleNamespace

import pytest
from app.services.audio_alignment_service import (
    AudioAlignmentService,
    AlignedWord,
    MaskInterval,
    _refine_aligned_word_boundaries,
    build_mask_intervals,
    tokenize_transcript_words,
)


def test_transcript_tokenization_preserves_original_offsets():
    words = tokenize_transcript_words("Call John-Doe, at 5pm.")

    assert [(word.text, word.normalized_text, word.start_char, word.end_char) for word in words] == [
        ("Call", "CALL", 0, 4),
        ("John-Doe,", "JOHNDOE", 5, 14),
        ("at", "AT", 15, 17),
        ("5", "FIVE", 18, 19),
        ("pm.", "PM", 19, 22),
    ]


def test_transcript_tokenization_expands_multi_digit_numbers_for_alignment():
    words = tokenize_transcript_words("Account 4829 ships to 118 Market Street.")

    assert [(word.text, word.normalized_text, word.start_char, word.end_char) for word in words] == [
        ("Account", "ACCOUNT", 0, 7),
        ("4", "FOUR", 8, 9),
        ("8", "EIGHT", 9, 10),
        ("2", "TWO", 10, 11),
        ("9", "NINE", 11, 12),
        ("ships", "SHIPS", 13, 18),
        ("to", "TO", 19, 21),
        ("1", "ONE", 22, 23),
        ("1", "ONE", 23, 24),
        ("8", "EIGHT", 24, 25),
        ("Market", "MARKET", 26, 32),
        ("Street.", "STREET", 33, 40),
    ]


def test_numeric_pii_mask_intervals_cover_expanded_digit_words():
    transcript = "Account 4829"
    transcript_words = tokenize_transcript_words(transcript)
    words = [
        {
            "text": word.text,
            "start_char": word.start_char,
            "end_char": word.end_char,
            "start_seconds": 0.1 + index * 0.2,
            "end_seconds": 0.24 + index * 0.2,
        }
        for index, word in enumerate(transcript_words)
    ]
    annotations = [{"id": "acct-4829", "label": "ACCOUNT_NUMBER", "start": 8, "end": 12, "value": "4829"}]

    intervals = build_mask_intervals(words, annotations, audio_duration=2.0, padding_seconds=0.08)

    assert len(intervals) == 1
    assert intervals[0].id == "acct-4829"
    assert intervals[0].labels == ["ACCOUNT_NUMBER"]
    assert intervals[0].text == "4 8 2 9"
    assert intervals[0].start_seconds == pytest.approx(0.22)
    assert intervals[0].end_seconds == pytest.approx(1.12)


def test_pii_mask_intervals_cover_aligned_words_and_merge_overlaps():
    words = [
        {
            "text": "Call",
            "start_char": 0,
            "end_char": 4,
            "start_seconds": 0.1,
            "end_seconds": 0.3,
        },
        {
            "text": "John",
            "start_char": 5,
            "end_char": 9,
            "start_seconds": 0.32,
            "end_seconds": 0.6,
        },
        {
            "text": "Doe",
            "start_char": 10,
            "end_char": 13,
            "start_seconds": 0.62,
            "end_seconds": 0.8,
        },
    ]
    annotations = [
        {"label": "NAME", "start": 5, "end": 9, "value": "John"},
        {"label": "NAME", "start": 10, "end": 13, "value": "Doe"},
    ]

    intervals = build_mask_intervals(words, annotations, audio_duration=2.0, padding_seconds=0.04)

    assert len(intervals) == 1
    assert intervals[0].start_seconds == 0.28
    assert round(intervals[0].end_seconds, 2) == 0.84
    assert intervals[0].labels == ["NAME"]
    assert intervals[0].text == "John / Doe"


def test_alignment_loads_pcm_wav_without_torchcodec(tmp_path):
    torch = pytest.importorskip("torch")
    source_path = tmp_path / "source.wav"
    sample_rate = 8000
    samples = [0, 8192, -8192, 16384]
    with wave.open(str(source_path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(b"".join(struct.pack("<h", sample) for sample in samples))

    torchaudio = SimpleNamespace(load=lambda _: (_ for _ in ()).throw(AssertionError("torchaudio.load used")))
    waveform, loaded_sample_rate = AudioAlignmentService()._load_waveform(source_path, torch, torchaudio)

    assert loaded_sample_rate == sample_rate
    assert tuple(waveform.shape) == (1, len(samples))
    assert waveform[0, 0].item() == 0
    assert round(waveform[0, 1].item(), 2) == 0.25
    assert round(waveform[0, 2].item(), 2) == -0.25


def test_alignment_refines_word_boundaries_to_local_speech_energy():
    torch = pytest.importorskip("torch")
    sample_rate = 1000
    waveform = torch.zeros(sample_rate)
    waveform[220:640] = 0.5

    refined = _refine_aligned_word_boundaries(
        [
            AlignedWord(
                index=0,
                text="hello",
                normalized_text="HELLO",
                start_char=0,
                end_char=5,
                start_seconds=0.0,
                end_seconds=0.9,
                score=0.8,
            )
        ],
        waveform,
        sample_rate,
    )

    assert 0.18 <= refined[0].start_seconds <= 0.23
    assert 0.63 <= refined[0].end_seconds <= 0.69


def test_wav_masking_silences_only_selected_audio(tmp_path):
    source_path = tmp_path / "source.wav"
    output_path = tmp_path / "masked.wav"
    sample_rate = 8000
    samples = [
        int(12000 * math.sin(2 * math.pi * 440 * index / sample_rate))
        for index in range(sample_rate)
    ]
    with wave.open(str(source_path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(b"".join(struct.pack("<h", sample) for sample in samples))

    service = AudioAlignmentService()
    wrote = service._try_mask_wav_file(
        source_path,
        output_path,
        [MaskInterval(start_seconds=0.2, end_seconds=0.4, labels=["PHONE"], text="1234")],
    )

    assert wrote is True
    with wave.open(str(output_path), "rb") as reader:
        frames = reader.readframes(reader.getnframes())
    masked_samples = struct.unpack(f"<{len(frames) // 2}h", frames)

    assert any(abs(sample) > 0 for sample in masked_samples[: int(sample_rate * 0.15)])
    assert set(masked_samples[int(sample_rate * 0.2) : int(sample_rate * 0.4)]) == {0}
    assert any(abs(sample) > 0 for sample in masked_samples[int(sample_rate * 0.45) : int(sample_rate * 0.6)])


def test_wav_masking_can_replace_selected_audio_with_beep(tmp_path):
    source_path = tmp_path / "source.wav"
    output_path = tmp_path / "masked-beep.wav"
    sample_rate = 8000
    samples = [
        int(12000 * math.sin(2 * math.pi * 220 * index / sample_rate))
        for index in range(sample_rate)
    ]
    with wave.open(str(source_path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(b"".join(struct.pack("<h", sample) for sample in samples))

    service = AudioAlignmentService()
    wrote = service._try_mask_wav_file(
        source_path,
        output_path,
        [MaskInterval(start_seconds=0.2, end_seconds=0.4, labels=["PHONE"], text="1234")],
        mask_mode="beep",
    )

    assert wrote is True
    with wave.open(str(output_path), "rb") as reader:
        frames = reader.readframes(reader.getnframes())
    masked_samples = struct.unpack(f"<{len(frames) // 2}h", frames)
    beep_region = masked_samples[int(sample_rate * 0.2) : int(sample_rate * 0.4)]

    assert any(abs(sample) > 0 for sample in beep_region)
    assert set(beep_region) != {0}
    assert beep_region != tuple(samples[int(sample_rate * 0.2) : int(sample_rate * 0.4)])


def test_custom_mask_intervals_do_not_require_saved_pii_annotations(tmp_path, monkeypatch):
    source_path = tmp_path / "source.wav"
    output_path = tmp_path / "custom-masked.wav"
    sample_rate = 8000
    samples = [
        int(12000 * math.sin(2 * math.pi * 440 * index / sample_rate))
        for index in range(sample_rate)
    ]
    with wave.open(str(source_path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(b"".join(struct.pack("<h", sample) for sample in samples))

    service = AudioAlignmentService()
    monkeypatch.setattr(service, "_masked_audio_path", lambda _task_id, _hash: output_path)
    task = SimpleNamespace(
        id="task-custom-mask",
        file_location=str(source_path),
        final_transcript="call me",
        pii_annotations=[],
        alignment_words=[],
        alignment_transcript_hash=None,
        alignment_model=None,
        alignment_updated_at=None,
        masked_audio_location=None,
        masked_audio_pii_hash=None,
        masked_audio_updated_at=None,
    )

    masked_location, intervals = service.build_pii_masked_audio(
        task,
        custom_intervals=[
            {"start_seconds": 0.2, "end_seconds": 0.4, "labels": ["PHONE"], "text": "555-0101"}
        ],
    )

    assert masked_location == str(output_path)
    assert intervals == [{"start_seconds": 0.2, "end_seconds": 0.4, "labels": ["PHONE"], "text": "555-0101"}]
    assert output_path.is_file()


def test_human_adjusted_mask_intervals_become_quality_reference(tmp_path, monkeypatch):
    source_path = tmp_path / "source.wav"
    output_path = tmp_path / "human-adjusted-mask.wav"
    sample_rate = 8000
    samples = [
        int(12000 * math.sin(2 * math.pi * 440 * index / sample_rate))
        for index in range(sample_rate)
    ]
    with wave.open(str(source_path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(b"".join(struct.pack("<h", sample) for sample in samples))

    service = AudioAlignmentService()
    monkeypatch.setattr(service, "_masked_audio_path", lambda _task_id, _hash: output_path)
    monkeypatch.setattr(
        service,
        "align_task_audio",
        lambda task, force=False: [
            {
                "index": 0,
                "text": "John",
                "normalized_text": "JOHN",
                "start_char": 0,
                "end_char": 4,
                "start_seconds": 0.2,
                "end_seconds": 0.54,
                "score": 0.94,
            }
        ],
    )
    task = SimpleNamespace(
        id="task-human-adjusted-mask",
        file_location=str(source_path),
        final_transcript="John",
        pii_annotations=[{"id": "pii-1", "label": "NAME", "start": 0, "end": 4, "value": "John"}],
        alignment_words=[],
        alignment_transcript_hash=None,
        alignment_model=None,
        alignment_updated_at=None,
        masked_audio_location=None,
        masked_audio_pii_hash=None,
        masked_audio_updated_at=None,
        masked_audio_intervals=[],
        masked_audio_reference_intervals=[],
        masked_audio_mode=None,
    )
    human_adjusted_interval = {
        "id": "pii-1",
        "source_annotation_ids": ["pii-1"],
        "start_seconds": 0.2,
        "end_seconds": 0.4,
        "labels": ["NAME"],
        "text": "John",
    }

    service.build_pii_masked_audio(task, custom_intervals=[human_adjusted_interval])

    assert task.masked_audio_intervals == [human_adjusted_interval]
    assert task.masked_audio_reference_intervals == [human_adjusted_interval]
    assert task.masked_audio_alignment_intervals == [
        {
            "start_seconds": 0.12,
            "end_seconds": 0.62,
            "labels": ["NAME"],
            "text": "John",
            "id": "pii-1",
            "source_annotation_ids": ["pii-1"],
        }
    ]
