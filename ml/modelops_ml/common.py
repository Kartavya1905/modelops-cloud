"""Pieces shared by both training scripts: data split, metrics, parity check, MLflow logging."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from sklearn.metrics import accuracy_score, f1_score, log_loss, roc_auc_score
from sklearn.model_selection import train_test_split

from .bundle import Bundle
from .datasets import (
    ChurnParams,
    features_and_label,
    generate,
    generator_params,
    sha256_of,
    to_canonical_csv,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass
class Split:
    x_train: np.ndarray
    x_test: np.ndarray
    y_train: np.ndarray
    y_test: np.ndarray
    dataset_sha256: str
    dataset_csv: bytes
    params: ChurnParams


def load_split(params: ChurnParams, test_size: float = 0.2) -> Split:
    df = generate(params)
    x, y = features_and_label(df)
    x_train, x_test, y_train, y_test = train_test_split(
        x, y, test_size=test_size, random_state=params.seed, stratify=y
    )
    return Split(x_train, x_test, y_train, y_test, sha256_of(df), to_canonical_csv(df), params)


def classification_metrics(y_true: np.ndarray, p_positive: np.ndarray) -> dict[str, float]:
    p = np.clip(p_positive, 1e-7, 1 - 1e-7)
    pred = (p >= 0.5).astype(np.int64)
    return {
        "test_accuracy": float(accuracy_score(y_true, pred)),
        "test_f1": float(f1_score(y_true, pred)),
        "test_roc_auc": float(roc_auc_score(y_true, p)),
        "test_log_loss": float(log_loss(y_true, p)),
    }


def parity(native_probabilities: np.ndarray, onnx_probabilities: np.ndarray) -> float:
    """Max absolute difference between the trained model and its ONNX export, on test data."""
    return float(np.max(np.abs(native_probabilities - onnx_probabilities)))


@dataclass
class TrainResult:
    framework: str
    bundle: Bundle
    metrics: dict[str, float]
    hyperparams: dict[str, str]
    split: Split
    series: dict[str, list[float]] = field(default_factory=dict)  # per-epoch curves
    train_seconds: float = 0.0


def lineage_tags(result: TrainResult) -> dict[str, str]:
    """Tags the platform reads when a run is registered as a model version (M3 registry)."""
    return {
        "modelops.framework": result.framework,
        "modelops.task": "binary_classification",
        "modelops.bundle.path": "model",
        "modelops.bundle.sha256": result.bundle.sha256,
        "modelops.dataset.name": "churn",
        "modelops.dataset.version": result.split.params.version_label,
        "modelops.dataset.sha256": result.split.dataset_sha256,
        "modelops.dataset.rows": str(result.split.params.n_rows),
    }


def default_tracking_uri() -> str:
    if os.environ.get("MLFLOW_TRACKING_URI"):
        return os.environ["MLFLOW_TRACKING_URI"]
    env_file = REPO_ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text("utf-8").splitlines():
            if line.startswith("MO_MLFLOW_URL="):
                return line.split("=", 1)[1].strip()
    return "http://127.0.0.1:15000"


def log_to_mlflow(result: TrainResult, experiment: str, run_name: str, tracking_uri: str) -> str:
    import mlflow  # imported lazily: tests that skip MLflow don't pay for it

    mlflow.set_tracking_uri(tracking_uri)
    mlflow.set_experiment(experiment)
    with mlflow.start_run(run_name=run_name) as run:
        mlflow.log_params({**result.hyperparams, **generator_params(result.split.params)})
        mlflow.set_tags(lineage_tags(result))
        mlflow.log_metrics({**result.metrics, "train_seconds": result.train_seconds})
        for key, values in result.series.items():
            for step, value in enumerate(values):
                mlflow.log_metric(key, value, step=step)
        mlflow.log_artifacts(str(result.bundle.directory), artifact_path="model")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "train.csv"
            path.write_bytes(result.split.dataset_csv)
            mlflow.log_artifact(str(path), artifact_path="dataset")
        return run.info.run_id


def base_parser(description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--experiment", help="MLflow experiment, e.g. modelops/<org-slug>/<project-slug>"
    )
    parser.add_argument("--tracking-uri", default=None, help="defaults to MO_MLFLOW_URL from .env")
    parser.add_argument("--run-name", default=None)
    parser.add_argument("--rows", type=int, default=20_000)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", type=Path, default=None, help="bundle directory (default: temp)")
    parser.add_argument("--no-mlflow", action="store_true", help="train and export only")
    parser.add_argument(
        "--summary-json",
        type=Path,
        default=None,
        help="also write the run summary to this file (MLflow prints its own lines to stdout)",
    )
    return parser


def run_cli(args: argparse.Namespace, result: TrainResult, default_run_name: str) -> None:
    summary = {
        "framework": result.framework,
        "metrics": {
            k: (f"{v:.1e}" if k == "parity_max_abs_diff" else round(v, 4))
            for k, v in result.metrics.items()
        },
        "bundle_sha256": result.bundle.sha256,
        "bundle_bytes": result.bundle.size_bytes,
        "opset": result.bundle.opset,
        "dataset": {
            "version": result.split.params.version_label,
            "sha256": result.split.dataset_sha256,
        },
        "train_seconds": round(result.train_seconds, 2),
    }
    if not args.no_mlflow:
        if not args.experiment:
            raise SystemExit("--experiment is required unless --no-mlflow is given")
        uri = args.tracking_uri or default_tracking_uri()
        summary["mlflow_run_id"] = log_to_mlflow(
            result, args.experiment, args.run_name or default_run_name, uri
        )
        summary["mlflow_experiment"] = args.experiment
    text = json.dumps(summary, indent=2)
    if args.summary_json:
        args.summary_json.write_text(text + "\n", "utf-8")
    print(text)


class Timer:
    def __enter__(self) -> Timer:
        self.start = time.perf_counter()
        return self

    def __exit__(self, *exc: object) -> None:
        self.seconds = time.perf_counter() - self.start
