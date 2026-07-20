import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from urllib.parse import urlparse


CHUNK_FILENAME_RE = re.compile(r"(?:^|[_-])chunk[_-]?(\d+)\.wav$", re.IGNORECASE)


@dataclass(frozen=True)
class AudioGroupInfo:
    group_key: str
    group_label: str
    query_prefix: str
    chunk_index: int | None
    filename: str


def audio_group_info(file_location: str) -> AudioGroupInfo | None:
    if not file_location:
        return None

    if file_location.startswith("s3://"):
        parsed = urlparse(file_location)
        key_path = PurePosixPath(parsed.path.lstrip("/"))
        return _group_from_path(
            path=key_path,
            group_prefix=f"s3://{parsed.netloc}",
            query_prefix=f"s3://{parsed.netloc}/",
        )

    if file_location.startswith("local://"):
        local_path = file_location.replace("local://", "", 1)
        return _group_from_path(
            path=PurePosixPath(local_path),
            group_prefix="local://",
            query_prefix="local://",
        )

    return _group_from_path(path=PurePosixPath(file_location), group_prefix="", query_prefix="")


def _group_from_path(path: PurePosixPath, *, group_prefix: str, query_prefix: str) -> AudioGroupInfo | None:
    filename = path.name
    if path.suffix.lower() != ".wav":
        return None
    parent = path.parent
    if not str(parent) or str(parent) == ".":
        return None

    chunk_match = CHUNK_FILENAME_RE.search(filename)
    chunk_index = int(chunk_match.group(1)) if chunk_match else None
    parent_text = str(parent).rstrip("/")

    if group_prefix == "local://":
        group_key = f"local://{parent_text}"
        prefix = f"local://{parent_text}/"
    elif group_prefix.startswith("s3://"):
        group_key = f"{group_prefix}/{parent_text}"
        prefix = f"{query_prefix}{parent_text}/"
    else:
        group_key = parent_text
        prefix = f"{parent_text}/"

    return AudioGroupInfo(
        group_key=group_key,
        group_label=parent.name or parent_text,
        query_prefix=prefix,
        chunk_index=chunk_index,
        filename=filename,
    )


def audio_group_sort_key(file_location: str) -> tuple[int, str]:
    info = audio_group_info(file_location)
    if not info:
        return (10**9, file_location)
    return (info.chunk_index if info.chunk_index is not None else 10**9, info.filename)


def normalize_transcript_words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", text.lower())

