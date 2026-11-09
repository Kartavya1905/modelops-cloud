"""Start-up: fetch the artifact through a presigned URL, verify its SHA-256, load it.

The server holds no storage credentials: the orchestrator passes one short-lived presigned URL
for exactly one object, plus the hash recorded when the version was validated. Any mismatch is
fatal, so a swapped or corrupted artifact can never serve traffic (docs/06, SEC-5).

The exit codes below are the contract with the orchestrator, which reads them from the
container state to set the revision's failure code.
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from dataclasses import dataclass
from typing import Any

import numpy as np
import onnxruntime as ort

EXIT_CONFIG = 2  # missing / malformed settings
EXIT_CHECKSUM = 3  # ARTIFACT_CHECKSUM_MISMATCH
EXIT_LOAD = 4  # MODEL_LOAD_ERROR
EXIT_DOWNLOAD = 5  # artifact could not be fetched (expired URL, storage down)

DTYPES = {"float32": np.float32, "float64": np.float64, "int32": np.int32, "int64": np.int64}


class StartupError(Exception):
    def __init__(self, exit_code: int, code: str, detail: str) -> None:
        super().__init__(detail)
        self.exit_code = exit_code
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Settings:
    artifact_url: str
    artifact_sha256: str
    signature: dict[str, Any]
    revision_id: str
    model_version_id: str
    max_artifact_bytes: int
    max_batch: int
    download_timeout_s: float

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> Settings:
        e = dict(os.environ) if env is None else env
        try:
            sha = e["MO_ARTIFACT_SHA256"].lower()
            if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
                raise ValueError("MO_ARTIFACT_SHA256 must be 64 hex characters")
            url = e["MO_ARTIFACT_URL"]
            if not url.startswith(("http://", "https://")):
                raise ValueError("MO_ARTIFACT_URL must be http(s)")
            return Settings(
                artifact_url=url,
                artifact_sha256=sha,
                signature=json.loads(e["MO_SIGNATURE"]),
                revision_id=e["MO_REVISION_ID"],
                model_version_id=e["MO_MODEL_VERSION_ID"],
                max_artifact_bytes=int(e.get("MO_MAX_ARTIFACT_BYTES", str(100 * 1024 * 1024))),
                max_batch=int(e.get("MO_MAX_BATCH", "64")),
                download_timeout_s=float(e.get("MO_DOWNLOAD_TIMEOUT_S", "30")),
            )
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            raise StartupError(EXIT_CONFIG, "INVALID_CONFIG", f"bad configuration: {exc}") from exc


def download(url: str, max_bytes: int, timeout_s: float) -> bytes:
    """Bounded download: never reads more than max_bytes + 1 bytes."""
    try:
        # Only the orchestrator-supplied presigned http(s) URL is ever opened (checked above).
        with urllib.request.urlopen(url, timeout=timeout_s) as res:  # noqa: S310
            data = res.read(max_bytes + 1)
    except OSError as exc:  # URLError, HTTPError, timeouts are all OSError
        raise StartupError(EXIT_DOWNLOAD, "ARTIFACT_DOWNLOAD_FAILED", str(exc)[:300]) from exc
    if len(data) > max_bytes:
        raise StartupError(EXIT_LOAD, "MODEL_LOAD_ERROR", f"artifact larger than {max_bytes} bytes")
    return data


@dataclass
class LoadedModel:
    session: ort.InferenceSession
    input_name: str
    input_dtype: Any
    width: int
    output_names: list[str]
    sha256: str
    size_bytes: int


def load(settings: Settings, data: bytes) -> LoadedModel:
    actual = hashlib.sha256(data).hexdigest()
    if actual != settings.artifact_sha256:
        raise StartupError(
            EXIT_CHECKSUM,
            "ARTIFACT_CHECKSUM_MISMATCH",
            f"expected sha256 {settings.artifact_sha256[:12]}…, got {actual[:12]}…",
        )
    sig_in = settings.signature["inputs"][0]
    try:
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        session = ort.InferenceSession(data, sess_options=opts, providers=["CPUExecutionProvider"])
    except Exception as exc:  # ORT raises several unrelated exception types
        raise StartupError(EXIT_LOAD, "MODEL_LOAD_ERROR", str(exc)[:300]) from exc
    return LoadedModel(
        session=session,
        input_name=sig_in["name"],
        input_dtype=DTYPES.get(sig_in["dtype"], np.float32),
        width=int(sig_in["shape"][1]),
        output_names=[o["name"] for o in settings.signature["outputs"]],
        sha256=actual,
        size_bytes=len(data),
    )
