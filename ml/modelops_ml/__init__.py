"""Trusted training code for the ModelOps Cloud demo models.

Pipeline: seeded synthetic churn data -> scikit-learn / PyTorch model -> ONNX bundle
(model.onnx + signature.json + golden_examples.json) -> MLflow run with lineage tags.
Only this trusted code ever touches pickle-capable formats; the platform receives ONNX only
(docs/adr/0002-onnx-only-serving.md).
"""

import os
import sys

# MLflow prints an "agent hint" on import; it adds nothing for training logs.
os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")

# The PyTorch ONNX exporter prints emoji; Windows consoles default to cp1252 and would crash.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")
