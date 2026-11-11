"""Start-up contract (exit codes) and the predict API of one model revision."""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pytest
from fastapi.testclient import TestClient

from model_server.app import create_app
from model_server.loader import (
    EXIT_CHECKSUM,
    EXIT_CONFIG,
    EXIT_DOWNLOAD,
    EXIT_LOAD,
    Settings,
    StartupError,
    download,
    load,
)

from .conftest import MODEL, MODEL_SHA, ArtifactServer, env_for, latent_nan_model_bytes

ROOT = Path(__file__).resolve().parents[1]


def start(artifacts: ArtifactServer, name: str = "model.onnx", **env: str):
    settings = Settings.from_env(env_for(artifacts.url(name), **env))
    data = download(settings.artifact_url, settings.max_artifact_bytes, 5)
    return settings, load(settings, data)


@pytest.fixture(scope="module")
def client(artifacts: ArtifactServer) -> TestClient:
    settings, model = start(artifacts)
    return TestClient(create_app(settings, model))


# ------------------------------------------------------------------------------ start-up
def test_checksum_mismatch_is_fatal(artifacts: ArtifactServer) -> None:
    with pytest.raises(StartupError) as exc:
        start(artifacts, MO_ARTIFACT_SHA256="0" * 64)
    assert (exc.value.exit_code, exc.value.code) == (EXIT_CHECKSUM, "ARTIFACT_CHECKSUM_MISMATCH")


def test_bytes_swapped_in_storage_are_detected(artifacts: ArtifactServer) -> None:
    tampered = MODEL[:-1] + bytes([MODEL[-1] ^ 1])
    artifacts.blobs["tampered.onnx"] = tampered
    with pytest.raises(StartupError) as exc:
        start(artifacts, "tampered.onnx")  # expected hash is still the validated one
    assert exc.value.code == "ARTIFACT_CHECKSUM_MISMATCH"


def test_unloadable_bytes_with_a_matching_hash_fail_to_load(artifacts: ArtifactServer) -> None:
    junk = b"definitely not an onnx graph"
    artifacts.blobs["junk.onnx"] = junk
    with pytest.raises(StartupError) as exc:
        start(artifacts, "junk.onnx", MO_ARTIFACT_SHA256=hashlib.sha256(junk).hexdigest())
    assert (exc.value.exit_code, exc.value.code) == (EXIT_LOAD, "MODEL_LOAD_ERROR")


def test_download_failure_and_size_limit(artifacts: ArtifactServer) -> None:
    with pytest.raises(StartupError) as missing:
        start(artifacts, "nope.onnx")
    assert missing.value.exit_code == EXIT_DOWNLOAD
    with pytest.raises(StartupError) as big:
        start(artifacts, MO_MAX_ARTIFACT_BYTES="100")
    assert big.value.exit_code == EXIT_LOAD


def test_bad_configuration(artifacts: ArtifactServer) -> None:
    with pytest.raises(StartupError) as exc:
        Settings.from_env(env_for("file:///etc/passwd"))
    assert exc.value.exit_code == EXIT_CONFIG
    with pytest.raises(StartupError):
        Settings.from_env(env_for(artifacts.url("model.onnx"), sha="xyz"))


def test_process_exits_with_the_checksum_code_before_listening(artifacts: ArtifactServer) -> None:
    """The real entry point, as the container runs it."""
    env = {**os.environ, **env_for(artifacts.url("model.onnx"), sha="f" * 64)}
    proc = subprocess.run(
        [sys.executable, "-m", "model_server"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == EXIT_CHECKSUM
    assert '"code": "ARTIFACT_CHECKSUM_MISMATCH"' in proc.stdout


# ------------------------------------------------------------------------------ serving
def test_health_ready_and_metadata(client: TestClient) -> None:
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/readyz").json()["sha256"] == MODEL_SHA
    meta = client.get("/metadata").json()
    assert meta["revisionId"] == "rev-1"
    assert meta["sizeBytes"] == len(MODEL)
    assert meta["onnxruntime"] == ort.__version__


def test_predictions_equal_onnx_runtime(client: TestClient) -> None:
    rows = np.random.default_rng(1).normal(size=(5, 6)).astype(np.float32)
    res = client.post("/v1/predict", json={"inputs": rows.tolist()})
    assert res.status_code == 200, res.text
    body = res.json()
    ref = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
    label, proba = ref.run(["label", "probabilities"], {"features": rows})
    assert body["outputs"]["label"] == label.tolist()
    np.testing.assert_allclose(body["outputs"]["probabilities"], proba, rtol=0, atol=1e-6)
    assert body["revisionId"] == "rev-1"


@pytest.mark.parametrize(
    ("payload", "status"),
    [
        ({"inputs": [[1, 2, 3]]}, 400),  # wrong width
        ({"inputs": [[0.0] * 6] * 65}, 400),  # batch over 64
        ('{"inputs": [[NaN, 0, 0, 0, 0, Infinity]]}', 400),  # not finite (raw JSON)
        ({"inputs": []}, 422),  # empty batch
        ({"inputs": [["a"] * 6]}, 422),  # wrong type
        ({"inputs": [[0.0] * 6], "extra": 1}, 422),  # unknown field
    ],
)
def test_invalid_inputs_are_rejected(client: TestClient, payload: dict | str, status: int) -> None:
    if isinstance(payload, str):
        res = client.post(
            "/v1/predict", content=payload, headers={"content-type": "application/json"}
        )
    else:
        res = client.post("/v1/predict", json=payload)
    assert res.status_code == status


def test_non_finite_outputs_are_an_explicit_500(artifacts: ArtifactServer) -> None:
    """A model that is fine on its golden rows but blows up on others answers 500, never NaN."""
    data = latent_nan_model_bytes()
    artifacts.blobs["nan.onnx"] = data
    settings, model = start(
        artifacts, "nan.onnx", MO_ARTIFACT_SHA256=hashlib.sha256(data).hexdigest()
    )
    nan_client = TestClient(create_app(settings, model))
    ok = nan_client.post("/v1/predict", json={"inputs": [[1, 2, 3, 4, 1, 6]]})
    assert ok.status_code == 200
    assert all(np.isfinite(ok.json()["outputs"]["probabilities"][0]))
    bad = nan_client.post("/v1/predict", json={"inputs": [[1, 2, 3, 4, 0, 6]]})
    assert bad.status_code == 500
    assert "non-finite" in bad.json()["detail"]


def test_predict_continues_the_gateway_trace(artifacts: ArtifactServer, monkeypatch) -> None:
    """M10: with a traceparent from the gateway, the predict span joins that trace."""
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from model_server.tracing import instrument

    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    settings, model = start(artifacts)
    exporter = InMemorySpanExporter()
    app = create_app(settings, model)  # not instrumented: no endpoint configured
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://unused:4318")
    assert instrument(app, "rev-1", "mv-1", exporter=exporter)
    trace_id, parent = "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"
    res = TestClient(app).post(
        "/v1/predict",
        json={"inputs": [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6]]},
        headers={"traceparent": f"00-{trace_id}-{parent}-01"},
    )
    assert res.status_code == 200
    spans = [s for s in exporter.get_finished_spans() if s.kind.name == "SERVER"]
    assert spans, "no server span"
    span = spans[0]
    assert format(span.context.trace_id, "032x") == trace_id
    assert format(span.parent.span_id, "016x") == parent
    assert span.resource.attributes["modelops.revision_id"] == "rev-1"
