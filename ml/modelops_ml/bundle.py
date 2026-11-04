"""The ONNX model bundle every training script produces (docs/06-security.md, section 2.1).

    model/
      model.onnx            declarative graph, preprocessing included, no external data
      signature.json        names, dtypes and shapes of inputs/outputs + feature names
      golden_examples.json  fixed inputs and the outputs ONNX Runtime produced for them

The platform replays the golden examples during validation (M4) and before a deployment goes
live (M5), so a model that behaves differently from what was trained can never serve traffic.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import onnx
import onnxruntime as ort

SIGNATURE_VERSION = 1
GOLDEN_TOLERANCE = 1e-5
ALLOWED_DOMAINS = {"", "ai.onnx", "ai.onnx.ml"}

INPUT_NAME = "features"
OUTPUT_LABEL = "label"
OUTPUT_PROBABILITIES = "probabilities"


def build_signature(feature_names: tuple[str, ...], classes: list[int]) -> dict[str, Any]:
    return {
        "signatureVersion": SIGNATURE_VERSION,
        "task": "binary_classification",
        "inputs": [
            {
                "name": INPUT_NAME,
                "dtype": "float32",
                "shape": [-1, len(feature_names)],
                "features": list(feature_names),
            }
        ],
        "outputs": [
            {"name": OUTPUT_LABEL, "dtype": "int64", "shape": [-1]},
            {
                "name": OUTPUT_PROBABILITIES,
                "dtype": "float32",
                "shape": [-1, len(classes)],
                "classes": classes,
            },
        ],
    }


def session(model_bytes: bytes) -> ort.InferenceSession:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    return ort.InferenceSession(model_bytes, sess_options=opts, providers=["CPUExecutionProvider"])


def onnx_predict(model_bytes: bytes, x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    labels, probabilities = session(model_bytes).run(
        [OUTPUT_LABEL, OUTPUT_PROBABILITIES], {INPUT_NAME: x.astype(np.float32)}
    )
    return np.asarray(labels), np.asarray(probabilities)


def assert_graph_matches_signature(model: onnx.ModelProto, signature: dict[str, Any]) -> None:
    """The bundle's two halves must agree; the platform re-checks this in M4 (check V7)."""
    graph_inputs = [i.name for i in model.graph.input]
    graph_outputs = [o.name for o in model.graph.output]
    want_inputs = [i["name"] for i in signature["inputs"]]
    want_outputs = [o["name"] for o in signature["outputs"]]
    if graph_inputs != want_inputs or sorted(graph_outputs) != sorted(want_outputs):
        raise ValueError(
            f"graph IO {graph_inputs}->{graph_outputs} != signature {want_inputs}->{want_outputs}"
        )
    domains = {node.domain for node in model.graph.node}
    for fn in model.functions:
        domains |= {node.domain for node in fn.node}
        domains.add(fn.domain)
    unexpected = domains - ALLOWED_DOMAINS - {fn.domain for fn in model.functions}
    if unexpected:
        raise ValueError(f"operator domains outside the allow-list: {sorted(unexpected)}")


@dataclass
class Bundle:
    directory: Path
    sha256: str
    size_bytes: int
    opset: dict[str, int] = field(default_factory=dict)


def write_bundle(
    out_dir: Path,
    model: onnx.ModelProto,
    signature: dict[str, Any],
    golden_inputs: np.ndarray,
    metadata: dict[str, str],
) -> Bundle:
    out_dir.mkdir(parents=True, exist_ok=True)
    for key, value in {"modelops.signature_version": str(SIGNATURE_VERSION), **metadata}.items():
        entry = model.metadata_props.add()
        entry.key, entry.value = key, value

    onnx.checker.check_model(model, full_check=True)
    assert_graph_matches_signature(model, signature)
    model_bytes = model.SerializeToString()  # single file; external data is never used

    labels, probabilities = onnx_predict(model_bytes, golden_inputs)
    golden = {
        "inputs": golden_inputs.astype(np.float32).tolist(),
        "outputs": {OUTPUT_LABEL: labels.tolist(), OUTPUT_PROBABILITIES: probabilities.tolist()},
        "tolerance": {"probabilities": GOLDEN_TOLERANCE, "label": 0},
    }

    (out_dir / "model.onnx").write_bytes(model_bytes)
    (out_dir / "signature.json").write_text(json.dumps(signature, indent=2) + "\n", "utf-8")
    (out_dir / "golden_examples.json").write_text(json.dumps(golden) + "\n", "utf-8")

    return Bundle(
        directory=out_dir,
        sha256=hashlib.sha256(model_bytes).hexdigest(),
        size_bytes=len(model_bytes),
        opset={(o.domain or "ai.onnx"): o.version for o in model.opset_import},
    )
