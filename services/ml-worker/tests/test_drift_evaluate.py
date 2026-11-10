"""M7: Evidently drift (both directions; silent on same-distribution samples) + evaluation."""

from __future__ import annotations

import hashlib
import io

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sklearn.metrics import roc_auc_score

from ml_worker import app as app_module
from ml_worker.drift import detect
from ml_worker.evaluate import read_dataset, score

from . import bundles as b

FEATURES = [
    "tenure_months",
    "monthly_charges",
    "support_tickets",
    "contract_type",
    "late_payments",
    "usage_hours",
]
TOKEN = "t" * 40


def churn_like(
    n: int, seed: int, charge_shift: float = 0.0, usage_scale: float = 1.0
) -> pd.DataFrame:
    """Same shape as ml/modelops_ml/datasets.py (the platform's training data)."""
    rng = np.random.default_rng(seed)
    contract = rng.choice(3, size=n, p=[0.55, 0.25, 0.20])
    monthly = np.clip(rng.normal(72.0 + charge_shift - 8.0 * contract, 20.0), 18.0, 160.0)
    return pd.DataFrame(
        {
            "tenure_months": np.clip(rng.gamma(2.0, 10.0 + 8.0 * contract), 0, 72)
            .round()
            .astype(np.int64),
            "monthly_charges": monthly.round(2),
            "support_tickets": rng.poisson(1.0 + 0.02 * np.clip(monthly - 70.0, 0, None)).astype(
                np.int64
            ),
            "contract_type": contract.astype(np.int64),
            "late_payments": rng.poisson(0.3 + 0.7 * (contract == 0)).astype(np.int64),
            "usage_hours": np.clip(rng.normal(42.0, 12.0) * usage_scale, 0, 250).round(1),
        }
    )


REFERENCE = churn_like(8000, seed=7)


# ------------------------------------------------------------------------------- drift
def test_same_distribution_does_not_drift() -> None:
    for seed in (11, 12, 13):  # several independent samples, not one lucky one
        result = detect(REFERENCE, churn_like(500, seed=seed), FEATURES)
        assert not result.dataset_drift, result
        assert result.drifted_count <= 1


@pytest.mark.parametrize("shift", [+30.0, -30.0])  # both directions
def test_shifted_charges_drift(shift: float) -> None:
    result = detect(REFERENCE, churn_like(500, seed=21, charge_shift=shift), FEATURES)
    by_name = {f.feature: f for f in result.features}
    assert by_name["monthly_charges"].drifted
    assert not by_name["tenure_months"].drifted


def test_strong_shift_flags_the_dataset_and_reports_every_feature() -> None:
    current = churn_like(500, seed=22, charge_shift=40.0, usage_scale=1.8)
    current["support_tickets"] = current["support_tickets"] + 3
    current["late_payments"] = current["late_payments"] + 2
    result = detect(REFERENCE, current, FEATURES)
    assert result.dataset_drift
    assert result.drift_share >= 0.5
    assert [f.feature for f in result.features] == FEATURES
    contract = next(f for f in result.features if f.feature == "contract_type")
    assert contract.kind == "categorical"
    payload = result.to_json()
    assert payload["referenceRows"] == 8000 and payload["currentRows"] == 500
    assert payload["evidentlyVersion"]


def test_drift_needs_enough_rows_and_the_right_columns() -> None:
    with pytest.raises(ValueError, match="30"):
        detect(REFERENCE, churn_like(10, seed=1), FEATURES)
    with pytest.raises(ValueError, match="missing"):
        detect(REFERENCE, churn_like(100, seed=1).drop(columns=["usage_hours"]), FEATURES)


# -------------------------------------------------------------------------- evaluation
def labelled(n: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Labels drawn from the reference logistic model, so it is the better model by design."""
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, 6)).astype(np.float32)
    import onnxruntime as ort

    p = ort.InferenceSession(b.logistic_model().SerializeToString()).run(
        ["probabilities"], {"features": x}
    )[0][:, 1]
    return x, (rng.random(n) < p).astype(np.int64)


def other_model() -> bytes:
    from onnx import numpy_helper

    m = b.logistic_model()
    w = numpy_helper.to_array(m.graph.initializer[0])
    m.graph.initializer[0].CopyFrom(numpy_helper.from_array(-w, "W"))  # flipped weights: worse
    return m.SerializeToString()


def test_scores_match_sklearn_and_rank_models() -> None:
    x, y = labelled(2000, seed=3)
    good = score(b.logistic_model().SerializeToString(), x, y, "features")
    bad = score(other_model(), x, y, "features")
    assert good.rows == 2000
    assert good.roc_auc > 0.7 > bad.roc_auc
    assert good.log_loss < bad.log_loss
    import onnxruntime as ort

    p1 = ort.InferenceSession(b.logistic_model().SerializeToString()).run(
        ["probabilities"], {"features": x}
    )[0][:, 1]
    assert good.roc_auc == pytest.approx(roc_auc_score(y, p1), abs=1e-6)


def test_dataset_checks() -> None:
    df = pd.DataFrame(np.zeros((60, 2)), columns=["a", "churned"])
    with pytest.raises(ValueError, match="missing"):
        read_dataset(df.to_csv(index=False).encode(), ["a", "b"], "churned")
    df["churned"] = 2
    with pytest.raises(ValueError, match="binary"):
        read_dataset(df.to_csv(index=False).encode(), ["a"], "churned")
    with pytest.raises(ValueError, match="50"):
        read_dataset(df.head(10).to_csv(index=False).encode(), ["a"], "churned")


# ---------------------------------------------------------------------------------- HTTP
@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("MO_ML_WORKER_TOKEN", TOKEN)
    app_module.settings.cache_clear()
    yield TestClient(app_module.app)
    app_module.settings.cache_clear()


def stub(monkeypatch, blobs: dict[str, bytes]) -> None:
    monkeypatch.setattr(app_module, "s3_client", lambda _s: object())
    monkeypatch.setattr(app_module, "_fetch", lambda _c, _b, key, _m: blobs[key])


def ref(data: bytes) -> dict[str, str]:
    h = hashlib.sha256(data).hexdigest()
    return {"key": f"blobs/sha256/{h}", "sha256": h}


def test_drift_endpoint(client, monkeypatch) -> None:
    csv = REFERENCE.to_csv(index=False).encode()
    stub(monkeypatch, {ref(csv)["key"]: csv})
    current = churn_like(300, seed=5, charge_shift=40).to_numpy(dtype=float).tolist()
    body = {"reference": ref(csv), "features": FEATURES, "current": current}
    assert client.post("/v1/drift", json=body).status_code == 401
    res = client.post("/v1/drift", json=body, headers={"X-ModelOps-Token": TOKEN})
    assert res.status_code == 200, res.text
    assert next(f for f in res.json()["features"] if f["feature"] == "monthly_charges")["drifted"]

    bad_rows = {**body, "current": [[1.0, 2.0]] * 40}
    assert (
        client.post("/v1/drift", json=bad_rows, headers={"X-ModelOps-Token": TOKEN}).status_code
        == 422
    )


def test_storage_tampering_is_refused(client, monkeypatch) -> None:
    csv = REFERENCE.to_csv(index=False).encode()
    r = ref(csv)
    stub(monkeypatch, {r["key"]: csv + b"1,2,3,4,5,6\n"})  # bytes changed behind the hash
    body = {"reference": r, "features": FEATURES, "current": [[0.0] * 6] * 40}
    res = client.post("/v1/drift", json=body, headers={"X-ModelOps-Token": TOKEN})
    assert res.status_code == 422
    assert "changed" in res.json()["detail"]


def test_evaluate_endpoint(client, monkeypatch) -> None:
    x, y = labelled(500, seed=9)
    df = pd.DataFrame(x, columns=[f"f{i}" for i in range(6)])
    df["churned"] = y
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    csv = buf.getvalue().encode()
    good, bad = b.logistic_model().SerializeToString(), other_model()
    stub(monkeypatch, {ref(csv)["key"]: csv, ref(good)["key"]: good, ref(bad)["key"]: bad})
    res = client.post(
        "/v1/evaluate",
        json={
            "dataset": ref(csv),
            "features": [f"f{i}" for i in range(6)],
            "inputName": "features",
            "candidate": ref(good),
            "baseline": ref(bad),
        },
        headers={"X-ModelOps-Token": TOKEN},
    )
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["candidate"]["rows"] == 500
    assert out["candidate"]["rocAuc"] > out["baseline"]["rocAuc"]
