"""Runs the model-touching checks in a separate, resource-limited child process.

Why a child process: parsing and loading a hostile file is the riskiest thing this service does.
If a crafted model exhausts memory, spins the CPU or crashes the runtime, only the child dies; the
web server keeps serving and reports a V8 failure.

Limits (Linux; the container always runs Linux):
  RLIMIT_AS   address space  (default 2 GiB)
  RLIMIT_CPU  CPU seconds    (default 30)
  wall clock  enforced by the parent (default 30 s), which kills the child
On Windows dev machines `resource` does not exist; the child still isolates crashes and the wall
clock still applies, and the report says limits were not enforced.
"""

from __future__ import annotations

import multiprocessing as mp
import sys
import time
from dataclasses import dataclass
from multiprocessing.connection import Connection
from typing import Any

from .checks import (
    CheckResult,
    Limits,
    check_checker,
    check_domains,
    check_external_data,
    check_format,
    check_opsets,
    check_signature,
    operators,
    run_session_checks,
)


@dataclass
class SandboxLimits:
    address_space_bytes: int = 2 * 1024**3
    cpu_seconds: int = 30
    wall_seconds: float = 30.0


def _apply_rlimits(limits: SandboxLimits) -> bool:
    try:
        import resource
    except ImportError:  # Windows
        return False
    resource.setrlimit(resource.RLIMIT_AS, (limits.address_space_bytes, limits.address_space_bytes))
    resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_seconds, limits.cpu_seconds))
    return True


def _peak_rss_mb() -> float | None:
    try:
        import resource
    except ImportError:
        return None
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(rss / 1024 / (1024 if sys.platform == "darwin" else 1), 1)


def _child(
    conn: Connection,
    model_bytes: bytes,
    signature: dict[str, Any],
    golden: dict[str, Any],
    limits: Limits,
    sandbox: SandboxLimits,
) -> None:
    out: dict[str, Any] = {"checks": [], "facts": {}}
    try:
        out["facts"]["rlimitsEnforced"] = _apply_rlimits(sandbox)
        v1, model = check_format(model_bytes)
        out["checks"].append(v1)
        if model is None:
            conn.send(out)
            return
        static = [
            check_checker(model),
            check_external_data(model),
            check_opsets(model),
            check_domains(model),
            check_signature(model, signature),
        ]
        out["checks"].extend(static)
        out["facts"]["opset"] = {(o.domain or "ai.onnx"): o.version for o in model.opset_import}
        out["facts"]["operators"] = sorted(f"{d or 'ai.onnx'}:{op}" for d, op in operators(model))
        if any(c.passed is False for c in static):
            # Never hand a model that failed a static check to the runtime.
            conn.send(out)
            return
        session_checks, facts = run_session_checks(model_bytes, signature, golden, limits)
        out["checks"].extend(session_checks)
        out["facts"].update(facts)
        peak = _peak_rss_mb()
        out["facts"]["peakRssMb"] = peak
        if peak is not None and peak > limits.max_rss_mb:
            for c in out["checks"]:
                if c.id == "V8":
                    c.passed = False
                    c.detail = f"peak memory {peak:.0f} MB (max {limits.max_rss_mb:.0f} MB)"
        conn.send(out)
    except MemoryError:
        conn.send({"fatal": "V8", "detail": "ran out of memory inside the sandbox limit"})
    except Exception as exc:
        # A runtime error loading or running the model is a property of the model, not of us.
        conn.send(
            {
                "fatal": "V8",
                "detail": f"model failed to load/run: {type(exc).__name__}: {exc}"[:400],
            }
        )
    finally:
        conn.close()


def run_sandboxed(
    model_bytes: bytes,
    signature: dict[str, Any],
    golden: dict[str, Any],
    limits: Limits,
    sandbox: SandboxLimits | None = None,
) -> tuple[list[CheckResult], dict[str, Any]]:
    sandbox = sandbox or SandboxLimits()
    ctx = mp.get_context("spawn")  # fresh interpreter: no inherited state, no fork surprises
    parent, child = ctx.Pipe(duplex=False)
    proc = ctx.Process(
        target=_child,
        args=(child, model_bytes, signature, golden, limits, sandbox),
        daemon=True,
    )
    started = time.perf_counter()
    proc.start()
    child.close()
    message: dict[str, Any] | None = None
    if parent.poll(sandbox.wall_seconds):
        try:
            message = parent.recv()
        except EOFError:
            message = None
    proc.join(timeout=2)
    if proc.is_alive():
        proc.kill()
        proc.join()
    elapsed = time.perf_counter() - started

    if message is None:
        reason = (
            f"exceeded the {sandbox.wall_seconds:.0f} s time limit"
            if elapsed >= sandbox.wall_seconds
            else f"sandbox process died (exit code {proc.exitcode}); likely a resource limit"
        )
        return [CheckResult("V8", False, reason)], {"sandboxExitCode": proc.exitcode}
    if "fatal" in message:
        return [CheckResult(message["fatal"], False, message["detail"])], {}
    return message["checks"], message["facts"]
