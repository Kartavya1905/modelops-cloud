"""A tiny logistic-regression ONNX model and a local HTTP server standing in for presigned S3."""

from __future__ import annotations

import hashlib
import http.server
import json
import threading
from collections.abc import Iterator
from typing import Any

import numpy as np
import pytest
from onnx import TensorProto, helper, numpy_helper

SIGNATURE: dict[str, Any] = {
    "signatureVersion": 1,
    "task": "binary_classification",
    "inputs": [
        {
            "name": "features",
            "dtype": "float32",
            "shape": [-1, 6],
            "features": ["f0", "f1", "f2", "f3", "f4", "f5"],
        }
    ],
    "outputs": [
        {"name": "label", "dtype": "int64", "shape": [-1]},
        {"name": "probabilities", "dtype": "float32", "shape": [-1, 2], "classes": [0, 1]},
    ],
}


def logistic_model_bytes() -> bytes:
    rng = np.random.default_rng(0)
    w = numpy_helper.from_array(rng.normal(size=(6, 2)).astype(np.float32), "W")
    b = numpy_helper.from_array(np.array([0.1, -0.1], dtype=np.float32), "B")
    graph = helper.make_graph(
        [
            helper.make_node("MatMul", ["features", "W"], ["z"]),
            helper.make_node("Add", ["z", "B"], ["logits"]),
            helper.make_node("Softmax", ["logits"], ["probabilities"], axis=1),
            helper.make_node("ArgMax", ["probabilities"], ["label"], axis=1, keepdims=0),
        ],
        "logistic",
        [helper.make_tensor_value_info("features", TensorProto.FLOAT, ["N", 6])],
        [
            helper.make_tensor_value_info("label", TensorProto.INT64, ["N"]),
            helper.make_tensor_value_info("probabilities", TensorProto.FLOAT, ["N", 2]),
        ],
        initializer=[w, b],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 10
    return model.SerializeToString()


def latent_nan_model_bytes() -> bytes:
    """Like the logistic model, but probabilities become NaN whenever feature 4 is below 0.5:
    probabilities * (sqrt(f4 - 0.5) * 0 + 1). A latent numerical bug, as in the M8 canary demo."""
    rng = np.random.default_rng(0)
    w = numpy_helper.from_array(rng.normal(size=(6, 2)).astype(np.float32), "W")
    b = numpy_helper.from_array(np.array([0.1, -0.1], dtype=np.float32), "B")
    const = {
        name: numpy_helper.from_array(np.array(v, dtype=dtype), name)
        for name, v, dtype in [
            ("starts", [4], np.int64),
            ("ends", [5], np.int64),
            ("axes", [1], np.int64),
            ("half", 0.5, np.float32),
            ("zero", 0.0, np.float32),
            ("one", 1.0, np.float32),
        ]
    }
    graph = helper.make_graph(
        [
            helper.make_node("MatMul", ["features", "W"], ["z"]),
            helper.make_node("Add", ["z", "B"], ["logits"]),
            helper.make_node("Softmax", ["logits"], ["p_raw"], axis=1),
            helper.make_node("Slice", ["features", "starts", "ends", "axes"], ["f4"]),
            helper.make_node("Sub", ["f4", "half"], ["shifted"]),
            helper.make_node("Sqrt", ["shifted"], ["root"]),
            helper.make_node("Mul", ["root", "zero"], ["nan_or_zero"]),
            helper.make_node("Add", ["nan_or_zero", "one"], ["factor"]),
            helper.make_node("Mul", ["p_raw", "factor"], ["probabilities"]),
            helper.make_node("ArgMax", ["p_raw"], ["label"], axis=1, keepdims=0),
        ],
        "latent_nan",
        [helper.make_tensor_value_info("features", TensorProto.FLOAT, ["N", 6])],
        [
            helper.make_tensor_value_info("label", TensorProto.INT64, ["N"]),
            helper.make_tensor_value_info("probabilities", TensorProto.FLOAT, ["N", 2]),
        ],
        initializer=[w, b, *const.values()],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 10
    return model.SerializeToString()


MODEL = logistic_model_bytes()
MODEL_SHA = hashlib.sha256(MODEL).hexdigest()


class ArtifactServer:
    """Serves byte blobs at /<name>; anything else is 404."""

    def __init__(self) -> None:
        self.blobs: dict[str, bytes] = {}
        blobs = self.blobs

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                data = blobs.get(self.path.lstrip("/"))
                if data is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: object) -> None:
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def url(self, name: str) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/{name}"

    def close(self) -> None:
        self.httpd.shutdown()


@pytest.fixture(scope="session")
def artifacts() -> Iterator[ArtifactServer]:
    server = ArtifactServer()
    server.blobs["model.onnx"] = MODEL
    yield server
    server.close()


def env_for(url: str, sha: str = MODEL_SHA, **extra: str) -> dict[str, str]:
    return {
        "MO_ARTIFACT_URL": url,
        "MO_ARTIFACT_SHA256": sha,
        "MO_SIGNATURE": json.dumps(SIGNATURE),
        "MO_REVISION_ID": "rev-1",
        "MO_MODEL_VERSION_ID": "mv-1",
        **extra,
    }
