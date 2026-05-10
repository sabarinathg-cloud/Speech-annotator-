import hashlib
import logging
import re
import threading
import time
from typing import Any

from app.core.config import get_settings

logger = logging.getLogger(__name__)

_gliner_model: Any | None = None
_piiranha_pipeline: Any | None = None
_spacy_model: Any | None = None
_spacy_unavailable = False
_gliner_lock = threading.Lock()
_piiranha_lock = threading.Lock()
_spacy_lock = threading.Lock()
_pii_model_preload_lock = threading.Lock()
_pii_model_preload_started = False


GLINER_LABELS = [
    "person name",
    "age",
    "location",
    "phone number",
    "aadhaar number",
    "email address",
    "insurance id",
    "doctor name",
    "institution name",
]

PIIRANHA_LABEL_MAP = {
    "ACCOUNTNUM": "ACCOUNT_NUMBER",
    "BUILDINGNUM": "ADDRESS",
    "CITY": "LOCATION",
    "CREDITCARDNUMBER": "CREDIT_CARD",
    "DATEOFBIRTH": "DATE",
    "DRIVERLICENSENUM": "ID_NUMBER",
    "EMAIL": "EMAIL",
    "GIVENNAME": "PERSON",
    "IDCARDNUM": "ID_NUMBER",
    "PASSWORD": "PASSWORD",
    "SOCIALNUM": "SSN",
    "STREET": "ADDRESS",
    "SURNAME": "PERSON",
    "TAXNUM": "ID_NUMBER",
    "TELEPHONENUM": "PHONE",
    "USERNAME": "USERNAME",
    "ZIPCODE": "ZIPCODE",
}

GLINER_LABEL_MAP = {
    "person name": "PERSON",
    "age": "AGE",
    "location": "LOCATION",
    "phone number": "PHONE",
    "aadhaar number": "AADHAAR_NUMBER",
    "email address": "EMAIL",
    "insurance id": "INSURANCE_ID",
    "doctor name": "PERSON",
    "institution name": "INSTITUTION",
    "account number": "ACCOUNT_NUMBER",
    "credit card number": "CREDIT_CARD",
    "id number": "ID_NUMBER",
    "ssn": "SSN",
    "username": "USERNAME",
    "password": "PASSWORD",
    "zipcode": "ZIPCODE",
    "date": "DATE",
}

SPACY_LABEL_MAP = {
    "ORG": "INSTITUTION",
    "GPE": "LOCATION",
    "LOC": "LOCATION",
}

LABEL_PRIORITY = {
    "PHONE": 1,
    "EMAIL": 2,
    "SSN": 3,
    "DATE": 4,
    "AADHAAR_NUMBER": 5,
    "INSURANCE_ID": 6,
    "ACCOUNT_NUMBER": 7,
    "CREDIT_CARD": 8,
    "ID_NUMBER": 9,
    "ZIPCODE": 10,
    "PERSON": 11,
    "USERNAME": 12,
    "PASSWORD": 13,
    "ADDRESS": 14,
    "LOCATION": 15,
    "INSTITUTION": 16,
    "AGE": 17,
    "OTHER": 999,
}

NAME_BLACKLIST = {
    "nurse",
    "assistant",
    "doctor",
    "agent",
    "representative",
    "coordinator",
    "service",
    "health",
    "calling",
    "message",
    "program",
    "care",
    "customer",
    "member",
    "patient",
    "appointment",
    "medication",
    "phone",
    "number",
    "name",
    "account",
    "address",
}

EMAIL_RE = re.compile(r"\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}(?!\d)")
SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
DOB_RE = re.compile(r"\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:\d{2}|\d{4})\b")
DATE_WORD_RE = re.compile(
    r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|"
    r"sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+"
    r"(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?(?:,?\s+\d{2,4})?\b",
    flags=re.IGNORECASE,
)
ZIP_RE = re.compile(r"\b\d{5}(?:-\d{4})?\b")
AADHAAR_RE = re.compile(r"(?<!\d)(?:\d{4}\s?\d{4}\s?\d{4})(?!\d)")
CREDIT_CARD_RE = re.compile(r"\b(?:\d[ -]*?){13,16}\b")
IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
URL_RE = re.compile(r"\bhttps?://[^\s/$.?#].[^\s]*\b", flags=re.IGNORECASE)
ADDRESS_RE = re.compile(
    r"\b\d{1,6}\s+(?!(?:at|to|in|on|near|for|about)\b)(?:[A-Za-z0-9.'-]+\s+){0,4}?"
    r"(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|"
    r"court|ct\.?|place|pl\.?|plaza|way|circle|cir\.?|terrace|ter\.?|parkway|pkwy\.?)\b",
    flags=re.IGNORECASE,
)
ID_CONTEXT_RE = re.compile(
    r"\b(?P<context>member|account|policy|reference|case|claim|mrn|subscriber|insurance|patient|medical record)"
    r"\s*(?:number|no\.?|#|id)?\s*[:\-]?\s*(?P<value>[A-Z0-9\-]{4,})\b",
    flags=re.IGNORECASE,
)

NAME_PATTERNS = [
    re.compile(
        r"\bthis message is for\s+([a-z]+(?:\s+[a-z]+){0,2}?)(?=\s+(?:my name is|this is|i am|i'm|calling|from|with|and)\b|[.,;!?]|$)",
        flags=re.IGNORECASE,
    ),
    re.compile(
        r"\bmy name is\s+([a-z]+(?:\s+[a-z]+){0,2}?)(?=\s+(?:i am|i'm|calling|from|with|and|on behalf|about)\b|[.,;!?]|$)",
        flags=re.IGNORECASE,
    ),
    re.compile(
        r"\bthis is\s+([a-z]+(?:\s+[a-z]+){0,2}?)(?=\s+(?:i am|i'm|calling|from|with|and|on behalf|about)\b|[.,;!?]|$)",
        flags=re.IGNORECASE,
    ),
    re.compile(
        r"\bspeaking with\s+([a-z]+(?:\s+[a-z]+){0,2}?)(?=\s+(?:from|at|and|about)\b|[.,;!?]|$)",
        flags=re.IGNORECASE,
    ),
]


def detect_pii_ensemble(
    text: str,
    *,
    gliner_threshold: float = 0.35,
    piiranha_threshold: float = 0.45,
    include_ml: bool = False,
) -> list[dict[str, Any]]:
    transcript = str(text or "")
    if not transcript.strip():
        return []

    candidates: list[dict[str, Any]] = []
    candidates.extend(_detect_regex(transcript))
    candidates.extend(_detect_rule_person_names(transcript))
    if include_ml or get_settings().pii_ml_detection_enabled:
        ml_start = time.perf_counter()
        logger.info("Running ML PII detectors for transcript length=%s", len(transcript))
        candidates.extend(_detect_gliner(transcript, threshold=gliner_threshold))
        candidates.extend(_detect_piiranha(transcript, threshold=piiranha_threshold))
        candidates.extend(_detect_spacy(transcript))
        logger.info("Finished ML PII detectors in %.2fs", time.perf_counter() - ml_start)
    return [_to_annotation(transcript, candidate) for candidate in _resolve_overlaps(_dedupe_entities(candidates))]


def preload_pii_detection_models() -> None:
    logger.info("Preloading PII ML detection models")
    for name, loader in (
        ("gliner", _get_gliner_model),
        ("piiranha", _get_piiranha_pipeline),
        ("spacy", _get_spacy_model),
    ):
        started_at = time.perf_counter()
        model = loader()
        if model is None:
            logger.warning("PII ML model %s was not loaded", name)
            continue
        logger.info("PII ML model %s ready in %.2fs", name, time.perf_counter() - started_at)


def start_pii_model_preload() -> bool:
    global _pii_model_preload_started
    with _pii_model_preload_lock:
        if _pii_model_preload_started:
            return False
        _pii_model_preload_started = True

    thread = threading.Thread(target=preload_pii_detection_models, name="pii-model-preload", daemon=True)
    thread.start()
    return True


def _detect_regex(text: str) -> list[dict[str, Any]]:
    entities: list[dict[str, Any]] = []

    for match in EMAIL_RE.finditer(text):
        entities.append(_entity("EMAIL", match.start(), match.end(), text, 0.98, "regex"))
    for match in PHONE_RE.finditer(text):
        entities.append(_entity("PHONE", match.start(), match.end(), text, 0.94, "regex"))
    for match in SSN_RE.finditer(text):
        entities.append(_entity("SSN", match.start(), match.end(), text, 0.99, "regex"))
    for match in DOB_RE.finditer(text):
        entities.append(_entity("DATE", match.start(), match.end(), text, 0.93, "regex"))
    for match in DATE_WORD_RE.finditer(text):
        entities.append(_entity("DATE", match.start(), match.end(), text, 0.86, "regex"))
    for match in AADHAAR_RE.finditer(text):
        entities.append(_entity("AADHAAR_NUMBER", match.start(), match.end(), text, 0.95, "regex"))
    for match in CREDIT_CARD_RE.finditer(text):
        entities.append(_entity("CREDIT_CARD", match.start(), match.end(), text, 0.9, "regex"))
    for match in ZIP_RE.finditer(text):
        entities.append(_entity("ZIPCODE", match.start(), match.end(), text, 0.8, "regex"))
    for match in IP_RE.finditer(text):
        entities.append(_entity("IP_ADDRESS", match.start(), match.end(), text, 0.84, "regex"))
    for match in URL_RE.finditer(text):
        entities.append(_entity("URL", match.start(), match.end(), text, 0.9, "regex"))
    for match in ADDRESS_RE.finditer(text):
        entities.append(_entity("ADDRESS", match.start(), match.end(), text, 0.9, "regex"))
    for match in ID_CONTEXT_RE.finditer(text):
        value = match.group("value")
        if not _is_valid_id_candidate(value):
            continue
        entities.append(
            _entity(
                _context_to_label(match.group("context")),
                match.start("value"),
                match.end("value"),
                text,
                0.9,
                "regex",
            )
        )
    return entities


def _detect_rule_person_names(text: str) -> list[dict[str, Any]]:
    entities: list[dict[str, Any]] = []
    for pattern in NAME_PATTERNS:
        for match in pattern.finditer(text):
            span_text = re.sub(r"\s+", " ", text[match.start(1) : match.end(1)].strip())
            if not _likely_person_name(span_text):
                continue
            entities.append(_entity("PERSON", match.start(1), match.end(1), text, 0.96, "rule_name"))
    return entities


def _detect_gliner(text: str, *, threshold: float) -> list[dict[str, Any]]:
    model = _get_gliner_model()
    if model is None:
        return []
    try:
        raw_entities = model.predict_entities(text, GLINER_LABELS, threshold=threshold)
    except Exception:
        return []

    entities: list[dict[str, Any]] = []
    for item in raw_entities:
        raw_label = str(item.get("label", "")).lower()
        label = GLINER_LABEL_MAP.get(raw_label, raw_label.upper().replace(" ", "_") or "OTHER")
        start = int(item.get("start", -1))
        end = int(item.get("end", -1))
        if start < 0 or end <= start:
            continue
        entities.append(_entity(label, start, end, text, float(item.get("score", 0.0)), "gliner"))
    return entities


def _detect_piiranha(text: str, *, threshold: float) -> list[dict[str, Any]]:
    pipe = _get_piiranha_pipeline()
    if pipe is None:
        return []
    try:
        raw_entities = pipe(text)
    except Exception:
        return []

    entities: list[dict[str, Any]] = []
    for item in raw_entities:
        raw_label = str(item.get("entity_group", item.get("entity", ""))).upper()
        label = PIIRANHA_LABEL_MAP.get(raw_label)
        score = float(item.get("score", 0.0))
        start = int(item.get("start", -1))
        end = int(item.get("end", -1))
        if label is None or score < threshold or start < 0 or end <= start:
            continue
        entities.append(_entity(label, start, end, text, score, "piiranha"))
    return entities


def _detect_spacy(text: str) -> list[dict[str, Any]]:
    nlp = _get_spacy_model()
    if nlp is None:
        return []
    try:
        doc = nlp(text)
    except Exception:
        return []
    entities: list[dict[str, Any]] = []
    for item in doc.ents:
        label = SPACY_LABEL_MAP.get(item.label_)
        if not label:
            continue
        entities.append(_entity(label, int(item.start_char), int(item.end_char), text, 0.62, "spacy"))
    return entities


def _get_gliner_model():
    global _gliner_model
    if _gliner_model is not None:
        return _gliner_model
    with _gliner_lock:
        if _gliner_model is not None:
            return _gliner_model
        try:
            from gliner import GLiNER
            from huggingface_hub import snapshot_download

            logger.info("Loading GLiNER PII model")
            model_dir = snapshot_download(
                repo_id="knowledgator/gliner-pii-large-v1.0",
                ignore_patterns=["onnx/*", "*.onnx"],
            )
            _gliner_model = GLiNER.from_pretrained(model_dir)
            return _gliner_model
        except Exception:
            logger.exception("Failed to load GLiNER PII model")
            return None


def _get_piiranha_pipeline():
    global _piiranha_pipeline
    if _piiranha_pipeline is not None:
        return _piiranha_pipeline
    with _piiranha_lock:
        if _piiranha_pipeline is not None:
            return _piiranha_pipeline
        try:
            import torch
            from transformers import pipeline

            device = 0 if torch.cuda.is_available() else -1
            logger.info("Loading Piiranha PII model on device=%s", device)
            _piiranha_pipeline = pipeline(
                "token-classification",
                model="iiiorg/piiranha-v1-detect-personal-information",
                tokenizer="iiiorg/piiranha-v1-detect-personal-information",
                aggregation_strategy="simple",
                device=device,
            )
            return _piiranha_pipeline
        except Exception:
            logger.exception("Failed to load Piiranha PII model")
            return None


def _get_spacy_model():
    global _spacy_model, _spacy_unavailable
    if _spacy_model is not None:
        return _spacy_model
    if _spacy_unavailable:
        return None
    with _spacy_lock:
        if _spacy_model is not None:
            return _spacy_model
        if _spacy_unavailable:
            return None
        try:
            import spacy

            logger.info("Loading spaCy PII fallback model")
            _spacy_model = spacy.load("en_core_web_sm")
            return _spacy_model
        except ModuleNotFoundError:
            _spacy_unavailable = True
            logger.warning("spaCy is not installed; skipping optional spaCy PII fallback model")
            return None
        except Exception:
            _spacy_unavailable = True
            logger.exception("Failed to load optional spaCy PII fallback model")
            return None


def _entity(label: str, start: int, end: int, text: str, score: float, source: str) -> dict[str, Any]:
    return {
        "label": label,
        "start": start,
        "end": end,
        "value": text[start:end],
        "score": max(0.0, min(1.0, score)),
        "source": source,
    }


def _to_annotation(text: str, entity: dict[str, Any]) -> dict[str, Any]:
    start = int(entity["start"])
    end = int(entity["end"])
    label = str(entity.get("label") or "OTHER").upper().replace(" ", "_")
    value = text[start:end]
    digest = hashlib.sha1(f"{label}:{start}:{end}:{value.lower()}".encode("utf-8")).hexdigest()[:12]
    return {
        "id": f"auto-{digest}",
        "label": label,
        "start": start,
        "end": end,
        "value": value,
        "source": str(entity.get("source") or "auto")[:32],
        "confidence": round(float(entity.get("score") or 0.0), 4),
    }


def _dedupe_entities(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    best: dict[tuple[int, int, str, str], dict[str, Any]] = {}
    for entity in entities:
        start = int(entity.get("start") or 0)
        end = int(entity.get("end") or 0)
        label = str(entity.get("label") or "OTHER").upper()
        value = str(entity.get("value") or "").strip().lower()
        if end <= start or not value:
            continue
        key = (start, end, label, value)
        current = best.get(key)
        if current is None or float(entity.get("score") or 0) > float(current.get("score") or 0):
            best[key] = entity
    return sorted(best.values(), key=lambda item: (int(item["start"]), int(item["end"])))


def _resolve_overlaps(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    for entity in sorted(
        entities,
        key=lambda item: (
            int(item["start"]),
            -(int(item["end"]) - int(item["start"])),
            LABEL_PRIORITY.get(str(item.get("label") or "OTHER"), 999),
            -float(item.get("score") or 0.0),
        ),
    ):
        replace_index: int | None = None
        skip = False
        for index, existing in enumerate(kept):
            overlaps = int(entity["start"]) < int(existing["end"]) and int(existing["start"]) < int(entity["end"])
            if not overlaps:
                continue
            entity_priority = LABEL_PRIORITY.get(str(entity.get("label") or "OTHER"), 999)
            existing_priority = LABEL_PRIORITY.get(str(existing.get("label") or "OTHER"), 999)
            entity_score = float(entity.get("score") or 0.0)
            existing_score = float(existing.get("score") or 0.0)
            entity_length = int(entity["end"]) - int(entity["start"])
            existing_length = int(existing["end"]) - int(existing["start"])
            if (entity_priority, -entity_score, -entity_length) < (existing_priority, -existing_score, -existing_length):
                replace_index = index
            else:
                skip = True
            break
        if replace_index is not None:
            kept[replace_index] = entity
        elif not skip:
            kept.append(entity)
    return sorted(kept, key=lambda item: (int(item["start"]), int(item["end"])))


def _likely_person_name(span_text: str) -> bool:
    tokens = str(span_text).strip().lower().split()
    if not tokens or len(tokens) > 3:
        return False
    if any(len(token) < 2 for token in tokens):
        return False
    if any(token in NAME_BLACKLIST for token in tokens):
        return False
    return True


def _is_valid_id_candidate(value: str) -> bool:
    normalized = re.sub(r"[^A-Za-z0-9]", "", value).lower()
    if len(normalized) < 4:
        return False
    if normalized.isalpha():
        return False
    return any(char.isdigit() for char in normalized)


def _context_to_label(context: str) -> str:
    normalized = context.lower()
    if "account" in normalized:
        return "ACCOUNT_NUMBER"
    if "insurance" in normalized or "member" in normalized or "subscriber" in normalized or "policy" in normalized:
        return "INSURANCE_ID"
    if "patient" in normalized or "medical" in normalized or "mrn" in normalized:
        return "ID_NUMBER"
    return "ID_NUMBER"
