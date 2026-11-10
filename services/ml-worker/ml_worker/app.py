"""Internal HTTP API of the ML worker (called only by the platform's Node worker).

    POST /v1/validate   validate one bundle stored in object storage (M4)
    POST /v1/drift      Evidently data drift: captured inputs vs the training dataset (M7)
    POST /v1/evaluate   score candidate (and baseline) models on a labelled dataset (M7)
    GET  /healthz       liveness

Authentication: a shared token in `X-ModelOps-Token` (the service is also only reachable from the
platform network). Storage access uses a READ-ONLY S3 identity scoped to the artifact bucket.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import os
from functools import lru_cache
from typing import Annotated, Any

import boto3
import pandas as pd
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import VALIDATOR_VERSION
from .checks import Limits
from .validate import validate_bundle

SHA256 = r"^[0-9a-f]{64}$"
KEY = r"^blobs/sha256/[0-9a-f]{64}$"


class BlobRef(BaseModel):
    key: str = Field(pattern=KEY)
    sha256: str = Field(pattern=SHA256)


class ValidateRequest(BaseModel):
    versionId: str = Field(min_length=1, max_length=64)
    model: BlobRef
    signature: BlobRef
    golden: BlobRef


FEATURE = r"^[A-Za-z_][A-Za-z0-9_]{0,63}$"
MAX_DATASET_BYTES = 100 * 1024 * 1024
Row = Annotated[list[float], Field(min_length=1, max_length=200)]


class DriftRequest(BaseModel):
    model_config = {"extra": "forbid"}
    reference: BlobRef
    features: Annotated[
        list[Annotated[str, Field(pattern=FEATURE)]], Field(min_length=1, max_length=200)
    ]
    current: Annotated[list[Row], Field(min_length=30, max_length=50_000)]


class EvaluateRequest(BaseModel):
    model_config = {"extra": "forbid"}
    dataset: BlobRef
    features: Annotated[
        list[Annotated[str, Field(pattern=FEATURE)]], Field(min_length=1, max_length=200)
    ]
    label: str = Field(default="churned", pattern=FEATURE)
    inputName: str = Field(pattern=FEATURE)
    candidate: BlobRef
    baseline: BlobRef | None = None


class Settings:
    def __init__(self) -> None:
        self.token = os.environ.get("MO_ML_WORKER_TOKEN", "")
        self.bucket = os.environ.get("MO_ARTIFACT_BUCKET", "model-artifacts")
        self.endpoint = os.environ.get("MO_S3_ENDPOINT", "http://127.0.0.1:18333")
        self.access_key = os.environ.get("MO_S3_VALIDATOR_ACCESS_KEY", "")
        self.secret_key = os.environ.get("MO_S3_VALIDATOR_SECRET_KEY", "")
        self.region = os.environ.get("MO_S3_REGION", "us-east-1")
        self.limits = Limits(
            max_model_bytes=int(os.environ.get("MO_VALIDATE_MAX_MODEL_BYTES", 100 * 1024 * 1024)),
            max_load_ms=float(os.environ.get("MO_VALIDATE_MAX_LOAD_MS", 10_000)),
            max_rss_mb=float(os.environ.get("MO_VALIDATE_MAX_RSS_MB", 512)),
            max_p95_ms=float(os.environ.get("MO_VALIDATE_MAX_P95_MS", 50)),
        )


@lru_cache
def settings() -> Settings:
    return Settings()


def s3_client(s: Settings) -> Any:
    return boto3.client(
        "s3",
        endpoint_url=s.endpoint,
        aws_access_key_id=s.access_key,
        aws_secret_access_key=s.secret_key,
        region_name=s.region,
        config=Config(
            s3={"addressing_style": "path"},
            retries={"max_attempts": 3},
            connect_timeout=5,
            read_timeout=60,
        ),
    )


def require_token(x_modelops_token: Annotated[str | None, Header()] = None) -> None:
    expected = settings().token
    if not expected or not x_modelops_token or not hmac.compare_digest(x_modelops_token, expected):
        raise HTTPException(status_code=401, detail="invalid or missing X-ModelOps-Token")


app = FastAPI(title="ModelOps ML worker", version=VALIDATOR_VERSION, docs_url=None, redoc_url=None)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "validatorVersion": VALIDATOR_VERSION}


def _fetch(client: Any, bucket: str, key: str, max_bytes: int) -> bytes:
    head = client.head_object(Bucket=bucket, Key=key)
    if int(head["ContentLength"]) > max_bytes:
        # Report as a size failure (V2) by returning a marker the caller turns into oversize bytes.
        raise OverflowError(int(head["ContentLength"]))
    body = client.get_object(Bucket=bucket, Key=key)["Body"]
    data = body.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise OverflowError(len(data))
    return data


@app.post("/v1/validate", dependencies=[Depends(require_token)])
def validate(req: ValidateRequest) -> dict[str, Any]:
    s = settings()
    client = s3_client(s)
    try:
        model = _fetch(client, s.bucket, req.model.key, s.limits.max_model_bytes)
        signature = _fetch(client, s.bucket, req.signature.key, s.limits.max_json_bytes)
        golden = _fetch(client, s.bucket, req.golden.key, s.limits.max_json_bytes)
    except OverflowError as exc:
        return {
            "result": "FAILED",
            "checks": [
                {
                    "id": "V2",
                    "name": "Size limits",
                    "passed": False,
                    "detail": f"object is {exc.args[0]} bytes",
                }
            ],
            "facts": {"validatorVersion": VALIDATOR_VERSION},
        }
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("404", "NoSuchKey", "NotFound"):
            raise HTTPException(status_code=422, detail="artifact not found in storage") from exc
        raise HTTPException(status_code=503, detail=f"storage error: {code}") from exc
    except BotoCoreError as exc:
        raise HTTPException(
            status_code=503, detail=f"storage unavailable: {type(exc).__name__}"
        ) from exc

    return validate_bundle(
        model,
        signature,
        golden,
        expected_sha256={
            "model": req.model.sha256,
            "signature": req.signature.sha256,
            "golden": req.golden.sha256,
        },
        limits=s.limits,
    )


def _blob(client: Any, s: Settings, ref: BlobRef, max_bytes: int) -> bytes:
    """Fetches a content-addressed blob and proves it is still the bytes we recorded."""
    try:
        data = _fetch(client, s.bucket, ref.key, max_bytes)
    except OverflowError as exc:
        raise HTTPException(status_code=422, detail=f"object is over {max_bytes} bytes") from exc
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("404", "NoSuchKey", "NotFound"):
            raise HTTPException(status_code=422, detail="object not found in storage") from exc
        raise HTTPException(status_code=503, detail=f"storage error: {code}") from exc
    except BotoCoreError as exc:
        raise HTTPException(status_code=503, detail="storage unavailable") from exc
    if hashlib.sha256(data).hexdigest() != ref.sha256:
        raise HTTPException(status_code=422, detail="content changed since it was recorded")
    return data


@app.post("/v1/drift", dependencies=[Depends(require_token)])
def drift(req: DriftRequest) -> dict[str, Any]:
    from .drift import detect  # Evidently is heavy: import only when drift is requested

    if any(len(row) != len(req.features) for row in req.current):
        raise HTTPException(status_code=422, detail="every current row needs one value per feature")
    s = settings()
    reference = pd.read_csv(io.BytesIO(_blob(s3_client(s), s, req.reference, MAX_DATASET_BYTES)))
    current = pd.DataFrame(req.current, columns=req.features)
    try:
        return detect(reference, current, req.features).to_json()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/v1/evaluate", dependencies=[Depends(require_token)])
def evaluate(req: EvaluateRequest) -> dict[str, Any]:
    from .evaluate import read_dataset, score

    s = settings()
    client = s3_client(s)
    try:
        x, y = read_dataset(
            _blob(client, s, req.dataset, MAX_DATASET_BYTES), req.features, req.label
        )
        candidate = score(
            _blob(client, s, req.candidate, s.limits.max_model_bytes), x, y, req.inputName
        )
        baseline = (
            score(_blob(client, s, req.baseline, s.limits.max_model_bytes), x, y, req.inputName)
            if req.baseline
            else None
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "candidate": candidate.to_json(),
        "baseline": baseline.to_json() if baseline else None,
    }
