"""Entry point: `python -m model_server`.

Load first, serve second: if the artifact can't be fetched, doesn't match its hash, or can't be
loaded, the process exits with a specific code before opening a port (see loader.py).
"""

from __future__ import annotations

import json
import sys

import uvicorn

from .app import create_app
from .loader import Settings, StartupError, download, load


def log(event: str, **fields: object) -> None:
    # Structured, single-line, and never containing request data.
    print(json.dumps({"event": event, **fields}), flush=True)


def main() -> int:
    try:
        settings = Settings.from_env()
        log("artifact.download", revisionId=settings.revision_id)
        data = download(
            settings.artifact_url, settings.max_artifact_bytes, settings.download_timeout_s
        )
        model = load(settings, data)
    except StartupError as exc:
        log("startup.failed", code=exc.code, detail=exc.detail, exitCode=exc.exit_code)
        return exc.exit_code
    log("model.loaded", revisionId=settings.revision_id, sha256=model.sha256)
    uvicorn.run(
        create_app(settings, model),
        host="0.0.0.0",  # noqa: S104 - container port on the internal network only
        port=8000,
        access_log=False,  # access logs would include paths only, but keep logs minimal
        server_header=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
