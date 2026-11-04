"""HTTP layer: authentication, request validation, storage errors (storage is stubbed here;
the real SeaweedFS path is covered by the API integration tests)."""

import pytest
from fastapi.testclient import TestClient

from ml_worker import app as app_module

from . import bundles as b

TOKEN = "t" * 40


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("MO_ML_WORKER_TOKEN", TOKEN)
    app_module.settings.cache_clear()
    yield TestClient(app_module.app)
    app_module.settings.cache_clear()


def body(bundle: b.Bundle) -> dict:
    h = bundle.hashes
    return {
        "versionId": "v1",
        "model": {"key": f"blobs/sha256/{h['model']}", "sha256": h["model"]},
        "signature": {"key": f"blobs/sha256/{h['signature']}", "sha256": h["signature"]},
        "golden": {"key": f"blobs/sha256/{h['golden']}", "sha256": h["golden"]},
    }


def stub_storage(monkeypatch, bundle: b.Bundle):
    blobs = {
        f"blobs/sha256/{v}": data
        for v, data in zip(
            bundle.hashes.values(), (bundle.model, bundle.signature, bundle.golden), strict=True
        )
    }
    monkeypatch.setattr(app_module, "s3_client", lambda _s: object())
    monkeypatch.setattr(app_module, "_fetch", lambda _c, _bucket, key, _max: blobs[key])


def test_healthz_needs_no_token(client):
    assert client.get("/healthz").json()["status"] == "ok"


@pytest.mark.parametrize("token", [None, "wrong", ""])
def test_validate_requires_the_shared_token(client, token):
    headers = {} if token is None else {"X-ModelOps-Token": token}
    assert (
        client.post("/v1/validate", json=body(b.valid_bundle()), headers=headers).status_code == 401
    )


def test_validate_runs_the_pipeline(client, monkeypatch):
    bundle = b.valid_bundle()
    stub_storage(monkeypatch, bundle)
    res = client.post("/v1/validate", json=body(bundle), headers={"X-ModelOps-Token": TOKEN})
    assert res.status_code == 200
    assert res.json()["result"] == "PASSED"


@pytest.mark.parametrize("key", ["../../etc/passwd", "blobs/sha256/../../x", "uploads-staging/abc"])
def test_only_content_addressed_keys_are_accepted(client, key):
    req = body(b.valid_bundle())
    req["model"]["key"] = key
    res = client.post("/v1/validate", json=req, headers={"X-ModelOps-Token": TOKEN})
    assert res.status_code == 422
