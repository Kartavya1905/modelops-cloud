"""Model A: scikit-learn GradientBoostingClassifier -> ONNX (TreeEnsemble, ai.onnx.ml).

    uv run --directory ml python -m modelops_ml.train_sklearn --experiment modelops/<org>/<project>

No feature scaling: trees are scale-invariant, and a StandardScaler in the pipeline made the
ONNX export disagree with scikit-learn (float32 vs float64 scaling moved samples across split
thresholds: max |dp| 4.3e-2 on 2 of 1200 test rows). Without it, parity is ~3e-7.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.pipeline import Pipeline

from .bundle import INPUT_NAME, build_signature, onnx_predict, write_bundle
from .common import (
    Timer,
    TrainResult,
    base_parser,
    classification_metrics,
    load_split,
    parity,
    run_cli,
)
from .datasets import FEATURES, ChurnParams

FRAMEWORK = "SKLEARN_ONNX"
PARITY_TOLERANCE = 1e-5


def train(
    params: ChurnParams,
    out_dir: Path,
    n_estimators: int = 150,
    max_depth: int = 3,
    learning_rate: float = 0.1,
) -> TrainResult:
    split = load_split(params)
    pipeline = Pipeline(
        [
            (
                "gbm",
                GradientBoostingClassifier(
                    n_estimators=n_estimators,
                    max_depth=max_depth,
                    learning_rate=learning_rate,
                    random_state=params.seed,
                ),
            ),
        ]
    )
    with Timer() as timer:
        pipeline.fit(split.x_train, split.y_train)

    onnx_model = convert_sklearn(
        pipeline,
        initial_types=[(INPUT_NAME, FloatTensorType([None, len(FEATURES)]))],
        target_opset={"": 17, "ai.onnx.ml": 3},
        options={GradientBoostingClassifier: {"zipmap": False}},
        # Fixed name: skl2onnx otherwise uses a random UUID, so identical training would
        # produce different bytes (and a different SHA-256).
        name="modelops_churn_gbm",
    )
    # skl2onnx names the outputs `label` / `probabilities` when zipmap is off; assert, don't assume.
    outputs = [o.name for o in onnx_model.graph.output]
    if outputs != ["label", "probabilities"]:
        raise RuntimeError(f"unexpected skl2onnx output names: {outputs}")

    signature = build_signature(FEATURES, classes=[0, 1])
    bundle = write_bundle(
        out_dir,
        onnx_model,
        signature,
        golden_inputs=split.x_test[:16],
        metadata={"modelops.framework": FRAMEWORK, "modelops.dataset.sha256": split.dataset_sha256},
    )

    native = pipeline.predict_proba(split.x_test)
    _, exported = onnx_predict((out_dir / "model.onnx").read_bytes(), split.x_test)
    diff = parity(native, exported)
    if diff > PARITY_TOLERANCE:
        raise RuntimeError(f"ONNX export differs from the trained model by {diff:.2e}")

    return TrainResult(
        framework=FRAMEWORK,
        bundle=bundle,
        metrics={**classification_metrics(split.y_test, native[:, 1]), "parity_max_abs_diff": diff},
        hyperparams={
            "model": "GradientBoostingClassifier",
            "n_estimators": str(n_estimators),
            "max_depth": str(max_depth),
            "learning_rate": str(learning_rate),
            "preprocessing": "none (trees are scale-invariant)",
        },
        split=split,
        train_seconds=timer.seconds,
    )


def main(argv: list[str] | None = None) -> None:
    parser = base_parser(__doc__ or "")
    parser.add_argument("--n-estimators", type=int, default=150)
    parser.add_argument("--max-depth", type=int, default=3)
    parser.add_argument("--learning-rate", type=float, default=0.1)
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory() as tmp:
        result = train(
            ChurnParams(n_rows=args.rows, seed=args.seed),
            args.out or Path(tmp) / "model",
            n_estimators=args.n_estimators,
            max_depth=args.max_depth,
            learning_rate=args.learning_rate,
        )
        run_cli(args, result, default_run_name=f"sklearn-gbm-{args.n_estimators}")


if __name__ == "__main__":
    main(sys.argv[1:])
