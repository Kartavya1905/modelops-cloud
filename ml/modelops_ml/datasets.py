"""Seeded synthetic customer-churn dataset.

Why synthetic: free, no licence or privacy issues, and, most importantly for later milestones,
it lets us *inject* two different kinds of change on purpose:

  * data drift    - the input distribution moves (``charge_shift``, ``usage_scale``)
  * concept drift - the relationship between inputs and the label changes (``concept_shift``)

The same parameters always produce byte-identical data on any OS, so the SHA-256 recorded in
MLflow is a real, verifiable dataset version reference.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

GENERATOR_VERSION = "churn-v1"
LABEL = "churned"

# Order matters: it is the column order of the model's input tensor (see signature.json).
FEATURES: tuple[str, ...] = (
    "tenure_months",
    "monthly_charges",
    "support_tickets",
    "contract_type",  # 0 = month-to-month, 1 = one year, 2 = two years
    "late_payments",
    "usage_hours",
)


@dataclass(frozen=True)
class ChurnParams:
    n_rows: int = 20_000
    seed: int = 7
    # data drift knobs
    charge_shift: float = 0.0
    usage_scale: float = 1.0
    # concept drift knob: 0 = support tickets increase churn, 1 = they *decrease* it
    concept_shift: float = 0.0

    def __post_init__(self) -> None:
        if self.n_rows < 10:
            raise ValueError("n_rows must be >= 10")
        if not 0.0 <= self.concept_shift <= 1.0:
            raise ValueError("concept_shift must be within [0, 1]")
        if self.usage_scale <= 0:
            raise ValueError("usage_scale must be > 0")

    @property
    def version_label(self) -> str:
        """Human-readable dataset version, e.g. ``seed7-n20000``."""
        label = f"seed{self.seed}-n{self.n_rows}"
        if self.charge_shift or self.usage_scale != 1.0 or self.concept_shift:
            label += f"-drift(c{self.charge_shift:g},u{self.usage_scale:g},k{self.concept_shift:g})"
        return label


DEFAULT_PARAMS = ChurnParams()


def generate(params: ChurnParams = DEFAULT_PARAMS) -> pd.DataFrame:
    rng = np.random.default_rng(params.seed)
    n = params.n_rows

    contract = rng.choice(3, size=n, p=[0.55, 0.25, 0.20])
    tenure = np.clip(rng.gamma(2.0, 10.0 + 8.0 * contract), 0, 72).round()
    monthly = np.clip(rng.normal(72.0 + params.charge_shift - 8.0 * contract, 20.0), 18.0, 160.0)
    tickets = rng.poisson(1.0 + 0.02 * np.clip(monthly - 70.0, 0, None))
    late = rng.poisson(0.3 + 0.7 * (contract == 0))
    usage = np.clip(rng.normal(42.0 - 0.08 * (monthly - 70.0), 12.0) * params.usage_scale, 0, 250)

    ticket_effect = 0.45 * (1.0 - params.concept_shift) - 0.35 * params.concept_shift
    logit = (
        -0.9
        - 0.05 * tenure
        + 0.03 * (monthly - 70.0)
        + ticket_effect * tickets
        - 0.8 * contract
        + 0.55 * late
        - 0.025 * (usage - 40.0)
    )
    probability = 1.0 / (1.0 + np.exp(-logit))
    churned = (rng.random(n) < probability).astype(np.int64)

    return pd.DataFrame(
        {
            "tenure_months": tenure.astype(np.int64),
            "monthly_charges": monthly.round(2),
            "support_tickets": tickets.astype(np.int64),
            "contract_type": contract.astype(np.int64),
            "late_payments": late.astype(np.int64),
            "usage_hours": usage.round(1),
            LABEL: churned,
        }
    )


def to_canonical_csv(df: pd.DataFrame) -> bytes:
    """Byte-stable encoding: fixed float format and LF line endings on every OS."""
    return df.to_csv(index=False, lineterminator="\n", float_format="%.4f").encode("utf-8")


def sha256_of(df: pd.DataFrame) -> str:
    return hashlib.sha256(to_canonical_csv(df)).hexdigest()


def generator_params(params: ChurnParams) -> dict[str, str]:
    """Everything needed to regenerate the exact dataset, logged to MLflow as params."""
    return {
        "dataset.generator": GENERATOR_VERSION,
        "dataset.numpy": np.__version__,
        **{f"dataset.{k}": str(v) for k, v in asdict(params).items()},
    }


def features_and_label(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    x = df.loc[:, list(FEATURES)].to_numpy(dtype=np.float32)
    y = df[LABEL].to_numpy(dtype=np.int64)
    return x, y
