"""Regenerates the small, real bundles used by the platform's integration tests.

    uv run --directory ml python -m modelops_ml.fixtures ../tests/fixtures/bundles

Each is trained by the same code as the demo models (tiny data), so the platform tests exercise
genuine scikit-learn and PyTorch ONNX exports, not hand-made graphs. Output is deterministic.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from . import train_pytorch, train_sklearn
from .datasets import ChurnParams

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


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("../tests/fixtures/bundles"))
