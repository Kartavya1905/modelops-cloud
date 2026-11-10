"""HTTP surface of one model revision (internal `inference` network only, docs/04 §4).

The gateway has already authenticated the caller and validated inputs against the signature;
the server validates the tensor shape again anyway (defence in depth) and never logs inputs.
"""

from __future__ import annotations

import time
from typing import Annotated, Any

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import SERVER_VERSION
from .loader import LoadedModel, Settings

Row = Annotated[list[float], Field(min_length=1, max_length=1024)]


class PredictRequest(BaseModel):
    model_config = {"extra": "forbid"}
    inputs: Annotated[list[Row], Field(min_length=1)]


def _jsonable(value: np.ndarray) -> Any:
    if value.dtype.kind in "iub":
        return value.astype(np.int64).tolist()
    return value.astype(np.float64).tolist()


def create_app(settings: Settings, model: LoadedModel) -> FastAPI:
    app = FastAPI(title="modelops-model-server", docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> dict[str, Any]:
        # The process only starts serving after the checksum was verified and the session loaded.
        return {"status": "ready", "revisionId": settings.revision_id, "sha256": model.sha256}

    @app.get("/metadata")
    def metadata() -> dict[str, Any]:
        return {
            "revisionId": settings.revision_id,
            "modelVersionId": settings.model_version_id,
            "sha256": model.sha256,
            "sizeBytes": model.size_bytes,
            "signature": settings.signature,
            "onnxruntime": ort.__version__,
            "serverVersion": SERVER_VERSION,
        }

    @app.post("/v1/predict")
    def predict(req: PredictRequest) -> dict[str, Any]:
        if len(req.inputs) > settings.max_batch:
            raise HTTPException(400, f"batch size is limited to {settings.max_batch}")
        if any(len(row) != model.width for row in req.inputs):
            raise HTTPException(400, f"every row must have exactly {model.width} values")
        x = np.asarray(req.inputs, dtype=model.input_dtype)
        if not np.isfinite(x).all():
            raise HTTPException(400, "inputs must be finite numbers")
        started = time.perf_counter()
        values = model.session.run(model.output_names, {model.input_name: x})
        elapsed_ms = (time.perf_counter() - started) * 1000
        # A model can blow up numerically on inputs its golden examples never covered. Say so
        # explicitly (a 500 the gateway counts against this revision), never return NaN/inf.
        for name, value in zip(model.output_names, values, strict=True):
            if value.dtype.kind == "f" and not np.isfinite(value).all():
                raise HTTPException(500, f"model produced non-finite values in '{name}'")
        return {
            "outputs": {n: _jsonable(v) for n, v in zip(model.output_names, values, strict=True)},
            "revisionId": settings.revision_id,
            "modelVersionId": settings.model_version_id,
            "inferenceMs": round(elapsed_ms, 3),
        }

    return app
