"""Offline evaluation: score a model on a labelled dataset version (candidate vs baseline).

Models reaching this point are VALIDATED (they passed the sandboxed checks V1-V11), so they are
loaded in-process with ONNX Runtime, one thread each. The gate *policy* lives in the platform;
this only measures.
"""

from __future__ import annotations

import io
from dataclasses import asdict, dataclass

import numpy as np
import onnxruntime as ort
import pandas as pd
from sklearn.metrics import accuracy_score, f1_score, log_loss, roc_auc_score


@dataclass(frozen=True)
class Metrics:
    rows: int
    accuracy: float
    f1: float
    roc_auc: float
    log_loss: float

    def to_json(self) -> dict[str, float | int]:
        d = asdict(self)
        return {
            "rows": d["rows"],
            "accuracy": d["accuracy"],
            "f1": d["f1"],
            "rocAuc": d["roc_auc"],
            "logLoss": d["log_loss"],
        }


def read_dataset(csv: bytes, features: list[str], label: str) -> tuple[np.ndarray, np.ndarray]:
    df = pd.read_csv(io.BytesIO(csv))
    missing = [c for c in [*features, label] if c not in df.columns]
    if missing:
        raise ValueError(f"dataset is missing columns: {', '.join(missing)}")
    if len(df) < 50:
        raise ValueError("an evaluation dataset needs at least 50 labelled rows")
    y = df[label].to_numpy()
    if not set(np.unique(y)) <= {0, 1}:
        raise ValueError(f"label {label!r} must be binary (0/1)")
    return df[features].to_numpy(dtype=np.float32), y.astype(np.int64)


def score(model: bytes, x: np.ndarray, y: np.ndarray, input_name: str) -> Metrics:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    session = ort.InferenceSession(model, sess_options=opts, providers=["CPUExecutionProvider"])
    outputs = {o.name: i for i, o in enumerate(session.get_outputs())}
    if "probabilities" not in outputs:
        raise ValueError("the model has no 'probabilities' output")
    proba = np.asarray(session.run(["probabilities"], {input_name: x})[0], dtype=np.float64)
    p1 = np.clip(proba[:, 1], 1e-7, 1 - 1e-7)
    predicted = (p1 >= 0.5).astype(np.int64)
    return Metrics(
        rows=len(y),
        accuracy=round(float(accuracy_score(y, predicted)), 6),
        f1=round(float(f1_score(y, predicted, zero_division=0)), 6),
        roc_auc=round(float(roc_auc_score(y, p1)) if len(set(y)) == 2 else float("nan"), 6),
        log_loss=round(float(log_loss(y, p1, labels=[0, 1])), 6),
    )
