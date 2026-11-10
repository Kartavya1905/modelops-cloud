"""Regenerates the small, real bundles used by the platform's integration tests.

    uv run --directory ml python -m modelops_ml.fixtures ../tests/fixtures/bundles
    uv run --directory ml python -m modelops_ml.fixtures ../tests/fixtures/bundles --latent-nan

Each is trained by the same code as the demo models (tiny data), so the platform tests exercise
genuine scikit-learn and PyTorch ONNX exports, not hand-made graphs. Output is deterministic.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper

from . import train_pytorch, train_sklearn
from .bundle import OUTPUT_PROBABILITIES, write_bundle
from .datasets import FEATURES, ChurnParams

PARAMS = ChurnParams(n_rows=1500, seed=3)


def main(out: Path) -> None:
    sk = train_sklearn.train(PARAMS, out / "sklearn", n_estimators=20, max_depth=2)
    pt = train_pytorch.train(PARAMS, out / "pytorch", epochs=3)
    manifest = {
        name: {
            "framework": r.framework,
            "sha256": r.bundle.sha256,
            "bytes": r.bundle.size_bytes,
            "datasetSha256": r.split.dataset_sha256,
        }
        for name, r in (("sklearn", sk), ("pytorch", pt))
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
    print(json.dumps(manifest, indent=2))


LATE_PAYMENTS = FEATURES.index("late_payments")


def latent_nan(out: Path) -> None:
    """The deliberately broken canary for M8 (docs/05 §6): the real scikit-learn bundle with a
    latent numerical bug. Its probabilities are multiplied by sqrt(late_payments - 0.5) * 0 + 1,
    which is exactly 1 when late_payments >= 1 and NaN when it is 0 (about half of real traffic).
    Its golden examples only contain rows with late payments, so it passes every validation
    check (V1-V11) and the pre-traffic golden check, like a real bug the tests never covered.
    Only live traffic exposes it: that is what a canary is for."""
    src = out / "sklearn"
    model = onnx.load(src / "model.onnx")
    graph = model.graph
    producer = next(n for n in graph.node if OUTPUT_PROBABILITIES in n.output)
    producer.output[list(producer.output).index(OUTPUT_PROBABILITIES)] = "p_raw"
    for name, value, dtype in [
        ("nan_starts", [LATE_PAYMENTS], np.int64),
        ("nan_ends", [LATE_PAYMENTS + 1], np.int64),
        ("nan_axes", [1], np.int64),
        ("nan_half", 0.5, np.float32),
        ("nan_zero", 0.0, np.float32),
        ("nan_one", 1.0, np.float32),
    ]:
        graph.initializer.append(numpy_helper.from_array(np.array(value, dtype=dtype), name))
    graph.node.extend(
        [
            helper.make_node(
                "Slice", ["features", "nan_starts", "nan_ends", "nan_axes"], ["nan_late"]
            ),
            helper.make_node("Sub", ["nan_late", "nan_half"], ["nan_shifted"]),
            helper.make_node("Sqrt", ["nan_shifted"], ["nan_root"]),
            helper.make_node("Mul", ["nan_root", "nan_zero"], ["nan_or_zero"]),
            helper.make_node("Add", ["nan_or_zero", "nan_one"], ["nan_factor"]),
            helper.make_node("Mul", ["p_raw", "nan_factor"], [OUTPUT_PROBABILITIES]),
        ]
    )
    del model.metadata_props[:]
    signature = json.loads((src / "signature.json").read_text("utf-8"))
    golden = json.loads((src / "golden_examples.json").read_text("utf-8"))
    rows = np.asarray([r for r in golden["inputs"] if r[LATE_PAYMENTS] >= 1], dtype=np.float32)
    bundle = write_bundle(
        out / "latent-nan",
        model,
        signature,
        rows,
        {"modelops.fixture": "latent-nan: NaN probabilities when late_payments == 0"},
    )
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text("utf-8"))
    manifest["latent-nan"] = {
        "framework": "SKLEARN_ONNX",
        "sha256": bundle.sha256,
        "bytes": bundle.size_bytes,
        "datasetSha256": manifest["sklearn"]["datasetSha256"],
        "goldenRows": len(rows),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
    print(json.dumps(manifest["latent-nan"], indent=2))


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    target = Path(args[0]) if args else Path("../tests/fixtures/bundles")
    if "--latent-nan" in sys.argv:
        latent_nan(target)
    else:
        main(target)
