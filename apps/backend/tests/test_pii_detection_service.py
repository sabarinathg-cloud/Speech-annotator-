from app.services import pii_detection_service
from app.routers import tasks as tasks_router
from app.services.pii_detection_service import detect_pii_ensemble


def spans_by_label(annotations):
    return {annotation["label"]: annotation for annotation in annotations}


def test_hybrid_detector_finds_numeric_context_pii_without_ml_models():
    text = (
        "Hello, this is Priya Raman calling about account 4829. "
        "My email is priya.raman@example.com and my phone is 415-555-0198."
    )

    annotations = detect_pii_ensemble(text)
    by_label = spans_by_label(annotations)

    assert by_label["PERSON"]["value"] == "Priya Raman"
    assert by_label["ACCOUNT_NUMBER"]["value"] == "4829"
    assert by_label["EMAIL"]["value"] == "priya.raman@example.com"
    assert by_label["PHONE"]["value"] == "415-555-0198"


def test_hybrid_detector_finds_address_and_dates_for_masking():
    text = "Please update the shipping address to 118 Market Street before 05/14/2026."

    annotations = detect_pii_ensemble(text)
    by_label = spans_by_label(annotations)

    assert by_label["ADDRESS"]["value"] == "118 Market Street"
    assert by_label["DATE"]["value"] == "05/14/2026"


def test_hybrid_detector_does_not_merge_account_numbers_into_addresses():
    text = "Hello, this is Priya Raman calling about account 4829 at 118 Market Street."

    annotations = detect_pii_ensemble(text)
    by_label = spans_by_label(annotations)

    assert by_label["ACCOUNT_NUMBER"]["value"] == "4829"
    assert by_label["ADDRESS"]["value"] == "118 Market Street"


def test_ml_detectors_do_not_block_default_detection(monkeypatch):
    def fail_if_loaded():
        raise AssertionError("ML detector should not load unless explicitly enabled")

    monkeypatch.setattr(pii_detection_service, "_get_gliner_model", fail_if_loaded)
    monkeypatch.setattr(pii_detection_service, "_get_piiranha_pipeline", fail_if_loaded)

    annotations = detect_pii_ensemble("Please call 415-555-0198 about account 4829.")
    by_label = spans_by_label(annotations)

    assert by_label["PHONE"]["value"] == "415-555-0198"
    assert by_label["ACCOUNT_NUMBER"]["value"] == "4829"


def test_ml_detectors_run_when_explicitly_requested(monkeypatch):
    calls = []

    monkeypatch.setattr(pii_detection_service, "_detect_gliner", lambda text, threshold: calls.append("gliner") or [])
    monkeypatch.setattr(pii_detection_service, "_detect_piiranha", lambda text, threshold: calls.append("piiranha") or [])
    monkeypatch.setattr(pii_detection_service, "_detect_spacy", lambda text: calls.append("spacy") or [])

    annotations = detect_pii_ensemble("Please call 415-555-0198.", include_ml=True)

    assert calls == ["gliner", "piiranha", "spacy"]
    assert spans_by_label(annotations)["PHONE"]["value"] == "415-555-0198"


def test_preload_pii_detection_models_loads_each_ml_backend(monkeypatch):
    calls = []

    monkeypatch.setattr(pii_detection_service, "_get_gliner_model", lambda: calls.append("gliner") or object())
    monkeypatch.setattr(pii_detection_service, "_get_piiranha_pipeline", lambda: calls.append("piiranha") or object())
    monkeypatch.setattr(pii_detection_service, "_get_spacy_model", lambda: calls.append("spacy") or object())

    pii_detection_service.preload_pii_detection_models()

    assert calls == ["gliner", "piiranha", "spacy"]


def test_start_pii_model_preload_starts_background_thread_once(monkeypatch):
    starts = []
    monkeypatch.setattr(pii_detection_service, "_pii_model_preload_started", False)

    class FakeThread:
        def __init__(self, *, target, name, daemon):
            self.target = target
            self.name = name
            self.daemon = daemon

        def start(self):
            starts.append((self.name, self.daemon, self.target))

    monkeypatch.setattr(pii_detection_service.threading, "Thread", FakeThread)

    assert pii_detection_service.start_pii_model_preload() is True
    assert pii_detection_service.start_pii_model_preload() is False
    assert len(starts) == 1
    assert starts[0][0] == "pii-model-preload"
    assert starts[0][1] is True


def test_pii_detection_endpoint_returns_annotation_payload(client, auth_headers):
    response = client.post(
        "/api/v1/tasks/detect-pii",
        headers=auth_headers["annotator"],
        json={"transcript": "Hello, this is Priya Raman calling about account 4829."},
    )

    assert response.status_code == 200
    annotations = response.json()["pii_annotations"]
    by_label = spans_by_label(annotations)
    assert by_label["ACCOUNT_NUMBER"]["value"] == "4829"
    assert by_label["PERSON"]["value"] == "Priya Raman"


def test_pii_detection_endpoint_can_request_all_models(client, auth_headers, monkeypatch):
    captured = {}

    def fake_detect(transcript, *, include_ml=False):
        captured["transcript"] = transcript
        captured["include_ml"] = include_ml
        return [
            {
                "id": "auto-phone",
                "label": "PHONE",
                "start": 8,
                "end": 20,
                "value": "415-555-0198",
                "source": "test",
                "confidence": 1.0,
            }
        ]

    monkeypatch.setattr(tasks_router, "detect_pii_ensemble", fake_detect)

    response = client.post(
        "/api/v1/tasks/detect-pii",
        headers=auth_headers["annotator"],
        json={"transcript": "Call me 415-555-0198", "include_ml": True},
    )

    assert response.status_code == 200
    assert captured == {"transcript": "Call me 415-555-0198", "include_ml": True}
    assert response.json()["pii_annotations"][0]["label"] == "PHONE"
