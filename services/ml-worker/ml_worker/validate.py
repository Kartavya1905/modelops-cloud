"""The full validation pipeline for one bundle, independent of where the bytes came from."""

from __future__ import annotations

import hashlib
from typing import Any

from . import VALIDATOR_VERSION
from .checks import CHECKS, CheckResult, Limits, Report, check_sizes, parse_json
from .sandbox import SandboxLimits, run_sandboxed


def validate_bundle(
    model: bytes,
    signature_bytes: bytes,
    golden_bytes: bytes,
    expected_sha256: dict[str, str],
    limits: Limits | None = None,
    sandbox: SandboxLimits | None = None,
) -> dict[str, Any]:
    """
    `expected_sha256` holds the hashes the platform computed when it ingested the files.
    V11 runs first: if the stored bytes changed since ingest, nothing else is even parsed.
    """
    limits = limits or Limits()
    report = Report()
    report.facts["validatorVersion"] = VALIDATOR_VERSION
    report.facts["sizeBytes"] = len(model)

    actual = {
        "model": hashlib.sha256(model).hexdigest(),
        "signature": hashlib.sha256(signature_bytes).hexdigest(),
        "golden": hashlib.sha256(golden_bytes).hexdigest(),
    }
    mismatched = [k for k, v in expected_sha256.items() if actual.get(k) != v]
    if mismatched:
        report.add(
            CheckResult("V11", False, f"content changed since ingest: {', '.join(mismatched)}")
        )
        report.skip_remaining(list(CHECKS), "artifact integrity check failed")
        return report.to_dict()
    report.add(CheckResult("V11", True, f"sha256 {actual['model'][:12]}…"))

    sizes = report.add(
        check_sizes(
            len(model),
            {"signature.json": len(signature_bytes), "golden_examples.json": len(golden_bytes)},
            limits,
        )
    )
    if not sizes.passed:
        report.skip_remaining(list(CHECKS), "size limit exceeded")
        return report.to_dict()

    signature, error = parse_json(signature_bytes, "signature.json")
    golden, golden_error = parse_json(golden_bytes, "golden_examples.json")
    if signature is None or golden is None:
        report.add(CheckResult("V7", False, error or golden_error or "invalid JSON"))
        report.skip_remaining(list(CHECKS), "bundle JSON is invalid")
        return report.to_dict()

    checks, facts = run_sandboxed(model, signature, golden, limits, sandbox)
    for c in checks:
        report.add(c)
    report.facts.update(facts)
    first_failure = next((c.id for c in report.checks if c.passed is False), None)
    report.skip_remaining(
        list(CHECKS), f"{first_failure} failed" if first_failure else "not reached"
    )
    return report.to_dict()
