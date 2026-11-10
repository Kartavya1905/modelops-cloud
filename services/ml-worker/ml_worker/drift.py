"""Data drift with Evidently, behind one function (risk R5: the Evidently API churns, so nothing
else in the platform touches it, and tests assert on *outputs*, not on Evidently internals).

Evidently picks a test per column from its type and the sample size:
  * p-value tests (K-S, chi-square, Z-test) for small samples: drifted when p < threshold
  * distances (Wasserstein normed, Jensen-Shannon, PSI) for larger ones: drifted when >= threshold
and calls the dataset drifted when at least `drift_share` of the columns drifted.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from importlib.metadata import version
from typing import Any

# Evidently ships opt-out usage telemetry. A platform component must not phone home.
os.environ.setdefault("EVIDENTLY_DISABLE_TELEMETRY", "1")

import pandas as pd
from evidently import DataDefinition, Dataset, Report
from evidently.presets import DataDriftPreset

DRIFT_SHARE = 0.5
EVIDENTLY_VERSION = version("evidently")


@dataclass(frozen=True)
class FeatureDrift:
    feature: str
    kind: str  # numerical | categorical
    method: str
    threshold: float
    score: float
    drifted: bool


@dataclass(frozen=True)
class DriftResult:
    dataset_drift: bool
    drift_share: float
    drifted_count: int
    features: list[FeatureDrift]
    reference_rows: int
    current_rows: int

    def to_json(self) -> dict[str, Any]:
        return {
            "datasetDrift": self.dataset_drift,
            "driftShare": self.drift_share,
            "driftedCount": self.drifted_count,
            "featureCount": len(self.features),
            "features": [asdict(f) for f in self.features],
            "referenceRows": self.reference_rows,
            "currentRows": self.current_rows,
            "evidentlyVersion": EVIDENTLY_VERSION,
            "driftShareThreshold": DRIFT_SHARE,
        }


def categorical_columns(reference: pd.DataFrame, features: list[str]) -> list[str]:
    """Integer columns with at most 5 distinct values (e.g. contract type) are categories."""
    out = []
    for f in features:
        col = reference[f]
        if pd.api.types.is_integer_dtype(col) and col.nunique() <= 5:
            out.append(f)
    return out


def is_p_value(method: str) -> bool:
    return (
        "p_value" in method
        or "p-value" in method
        or method.lower().startswith(("k-s", "chi-square", "z-test"))
    )


def detect(reference: pd.DataFrame, current: pd.DataFrame, features: list[str]) -> DriftResult:
    missing = [f for f in features if f not in reference.columns or f not in current.columns]
    if missing:
        raise ValueError(f"missing feature columns: {', '.join(missing)}")
    if len(current) < 30:
        raise ValueError("at least 30 current rows are needed for a meaningful drift test")
    categorical = categorical_columns(reference, features)
    numerical = [f for f in features if f not in categorical]
    definition = DataDefinition(numerical_columns=numerical, categorical_columns=categorical)
    ref = reference[features].copy()
    cur = current[features].copy()
    for f in categorical:  # same dtype on both sides, or Evidently compares apples and pears
        ref[f] = ref[f].astype("int64")
        cur[f] = cur[f].round().astype("int64")

    result = Report([DataDriftPreset(drift_share=DRIFT_SHARE)]).run(
        Dataset.from_pandas(cur, data_definition=definition),
        Dataset.from_pandas(ref, data_definition=definition),
    )
    per_feature: list[FeatureDrift] = []
    for metric in result.dict()["metrics"]:
        config = metric.get("config", {})
        if not str(config.get("type", "")).endswith("ValueDrift"):
            continue
        column, method = config["column"], str(config["method"])
        threshold, score = float(config["threshold"]), float(metric["value"])
        drifted = score < threshold if is_p_value(method) else score >= threshold
        per_feature.append(
            FeatureDrift(
                feature=column,
                kind="categorical" if column in categorical else "numerical",
                method=method,
                threshold=threshold,
                score=round(score, 6),
                drifted=drifted,
            )
        )
    per_feature.sort(key=lambda f: features.index(f.feature))
    drifted = sum(f.drifted for f in per_feature)
    share = drifted / len(per_feature) if per_feature else 0.0
    return DriftResult(
        dataset_drift=share >= DRIFT_SHARE,
        drift_share=round(share, 4),
        drifted_count=drifted,
        features=per_feature,
        reference_rows=len(ref),
        current_rows=len(cur),
    )
