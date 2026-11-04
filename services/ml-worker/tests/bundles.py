"""Builders for valid and hostile bundles, generated at test time (nothing is committed)."""

from __future__ import annotations

import hashlib
import io
import json
import os
import pickle
import zipfile
from dataclasses import dataclass
from typing import Any

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper

FEATURES = ["f0", "f1", "f2", "f3", "f4", "f5"]


def signature(dtype: str = "float32", width: int = 6) -> dict[str, Any]:
    return {
        "signatureVersion": 1,
        "task": "binary_classification",
        "inputs": [
            {"name": "features", "dtype": dtype, "shape": [-1, width], "features": FEATURES[:width]}
        ],
        "outputs": [
            {"name": "label", "dtype": "int64", "shape": [-1]},
            {"name": "probabilities", "dtype": "float32", "shape": [-1, 2], "classes": [0, 1]},
        ],
    }


def logistic_model(
    opset: int = 17,
    extra_nodes: list[onnx.NodeProto] | None = None,
    extra_opsets: list[onnx.OperatorSetIdProto] | None = None,
) -> onnx.ModelProto:
    """features[N,6] -> MatMul -> Add -> Softmax -> (probabilities, ArgMax label)."""
    rng = np.random.default_rng(0)
    w = numpy_helper.from_array(rng.normal(size=(6, 2)).astype(np.float32), "W")
    b = numpy_helper.from_array(np.array([0.1, -0.1], dtype=np.float32), "B")
    nodes = [
        helper.make_node("MatMul", ["features", "W"], ["z"]),
        helper.make_node("Add", ["z", "B"], ["logits"]),
        helper.make_node("Softmax", ["logits"], ["probabilities"], axis=1),
        helper.make_node("ArgMax", ["probabilities"], ["label"], axis=1, keepdims=0),
        *(extra_nodes or []),
    ]
    graph = helper.make_graph(
        nodes,
        "logistic",
        [helper.make_tensor_value_info("features", TensorProto.FLOAT, ["N", 6])],
        [
            helper.make_tensor_value_info("label", TensorProto.INT64, ["N"]),
            helper.make_tensor_value_info("probabilities", TensorProto.FLOAT, ["N", 2]),
        ],
        initializer=[w, b],
    )
    opsets = [helper.make_opsetid("", opset), *(extra_opsets or [])]
    return helper.make_model(graph, opset_imports=opsets, ir_version=8)


def golden_for(model_bytes: bytes, rows: int = 8) -> dict[str, Any]:
    x = np.random.default_rng(1).normal(size=(rows, 6)).astype(np.float32)
    label, probs = ort.InferenceSession(model_bytes, providers=["CPUExecutionProvider"]).run(
        ["label", "probabilities"], {"features": x}
    )
    return {
        "inputs": x.tolist(),
        "outputs": {"label": label.tolist(), "probabilities": probs.tolist()},
        "tolerance": {"probabilities": 1e-5, "label": 0},
    }


@dataclass
class Bundle:
    model: bytes
    signature: bytes
    golden: bytes

    @property
    def hashes(self) -> dict[str, str]:
        return {
            "model": hashlib.sha256(self.model).hexdigest(),
            "signature": hashlib.sha256(self.signature).hexdigest(),
            "golden": hashlib.sha256(self.golden).hexdigest(),
        }


def make_bundle(
    model: onnx.ModelProto | bytes,
    sig: dict[str, Any] | None = None,
    golden: dict[str, Any] | None = None,
) -> Bundle:
    data = model if isinstance(model, bytes) else model.SerializeToString()
    if golden is None:
        golden = golden_for(logistic_model().SerializeToString())
    return Bundle(data, json.dumps(sig or signature()).encode(), json.dumps(golden).encode())


def valid_bundle() -> Bundle:
    data = logistic_model().SerializeToString()
    return make_bundle(data, golden=golden_for(data))


# ---- hostile artifacts -----------------------------------------------------------------------


class _MakesSentinel:
    """If this object is ever unpickled, it creates `path`. The test asserts it never exists."""

    def __init__(self, path: str) -> None:
        self.path = path

    def __reduce__(self) -> tuple[Any, tuple[str]]:
        return (os.makedirs, (self.path,))


def pickle_payload(sentinel: str) -> bytes:
    return pickle.dumps(_MakesSentinel(sentinel), protocol=4)


def pickle_protocol0_payload(sentinel: str) -> bytes:
    return pickle.dumps(_MakesSentinel(sentinel), protocol=0)


def torch_style_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("archive/data.pkl", pickle.dumps({"weights": [1, 2, 3]}))
    return buf.getvalue()


def external_data_model(location: str = "../../etc/passwd") -> bytes:
    model = logistic_model()
    w = model.graph.initializer[0]
    w.ClearField("raw_data")
    w.data_location = TensorProto.EXTERNAL
    for key, value in (("location", location), ("offset", "0"), ("length", "48")):
        entry = w.external_data.add()
        entry.key, entry.value = key, value
    return model.SerializeToString()


def custom_op_model() -> bytes:
    evil = helper.make_node("Exploit", ["probabilities"], ["pwned"], domain="com.evil")
    model = logistic_model(extra_nodes=[evil], extra_opsets=[helper.make_opsetid("com.evil", 1)])
    return model.SerializeToString()


def custom_op_in_subgraph_model() -> bytes:
    """A custom op hidden inside an If-branch subgraph."""
    then_g = helper.make_graph(
        [helper.make_node("Exploit", ["probabilities"], ["out"], domain="com.evil")],
        "then",
        [],
        [helper.make_tensor_value_info("out", TensorProto.FLOAT, None)],
    )
    else_g = helper.make_graph(
        [helper.make_node("Identity", ["probabilities"], ["out2"])],
        "else",
        [],
        [helper.make_tensor_value_info("out2", TensorProto.FLOAT, None)],
    )
    cond = helper.make_node(
        "Constant", [], ["cond"], value=helper.make_tensor("c", TensorProto.BOOL, [], [False])
    )
    branch = helper.make_node(
        "If", ["cond"], ["branch_out"], then_branch=then_g, else_branch=else_g
    )
    model = logistic_model(
        extra_nodes=[cond, branch], extra_opsets=[helper.make_opsetid("com.evil", 1)]
    )
    return model.SerializeToString()
