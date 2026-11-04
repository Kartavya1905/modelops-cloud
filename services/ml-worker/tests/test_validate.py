"""One test per check, plus the adversarial cases from docs/06 (SEC-1 .. SEC-5)."""

import json
import os
import sys
import uuid
from pathlib import Path

import pytest

from ml_worker.checks import Limits
from ml_worker.sandbox import SandboxLimits
from ml_worker.validate import validate_bundle

from . import bundles as b


def run(bundle: b.Bundle, **kw):
    return validate_bundle(bundle.model, bundle.signature, bundle.golden, bundle.hashes, **kw)


def check(report, cid):
    return next(c for c in report["checks"] if c["id"] == cid)


def failed_ids(report):
    return [c["id"] for c in report["checks"] if c["passed"] is False]


# ---------------------------------------------------------------------------- happy path


def test_valid_bundle_passes_every_check_and_reports_facts():
    report = run(b.valid_bundle())
    assert report["result"] == "PASSED", report
    assert [c["id"] for c in report["checks"]] == [f"V{i}" for i in range(1, 12)]
    assert all(c["passed"] is True for c in report["checks"])
    facts = report["facts"]
    assert facts["opset"] == {"ai.onnx": 17}
    assert "ai.onnx:MatMul" in facts["operators"]
    assert facts["goldenRows"] == 8
    assert facts["loadMs"] >= 0 and facts["latencyP95Ms"] >= 0


# ---------------------------------------------------------------------------- SEC-1 pickle


@pytest.mark.parametrize("payload", [b.pickle_payload, b.pickle_protocol0_payload])
def test_pickle_disguised_as_onnx_is_rejected_and_never_executed(tmp_path: Path, payload):
    sentinel = tmp_path / f"pwned-{uuid.uuid4().hex}"
    report = run(b.make_bundle(payload(str(sentinel))))
    assert report["result"] == "FAILED"
    assert failed_ids(report) == ["V1"]
    assert "pickle" in check(report, "V1")["detail"]
    assert not sentinel.exists(), "the pickle payload was executed!"


def test_pytorch_zip_checkpoint_is_rejected():
    report = run(b.make_bundle(b.torch_style_zip()))
    assert failed_ids(report) == ["V1"]
    assert "zip archive" in check(report, "V1")["detail"]


def test_random_bytes_are_not_onnx():
    report = run(b.make_bundle(os.urandom(4096)))
    assert check(report, "V1")["passed"] is False


# ---------------------------------------------------------------------------- SEC-2 external data


def test_external_data_path_traversal_is_rejected_without_reading_the_file():
    report = run(b.make_bundle(b.external_data_model("../../etc/passwd")))
    v4 = check(report, "V4")
    assert v4["passed"] is False
    assert "../../etc/passwd" in v4["detail"]
    # never handed to the runtime
    assert check(report, "V8")["passed"] is None


# ---------------------------------------------------------------------------- SEC-3 custom ops


def test_custom_operator_domain_is_rejected():
    report = run(b.make_bundle(b.custom_op_model()))
    v6 = check(report, "V6")
    assert v6["passed"] is False and "com.evil:Exploit" in v6["detail"]
    assert check(report, "V8")["passed"] is None


def test_custom_operator_hidden_in_a_subgraph_is_found():
    report = run(b.make_bundle(b.custom_op_in_subgraph_model()))
    assert "com.evil:Exploit" in check(report, "V6")["detail"]


# ---------------------------------------------------------------------------- SEC-4 size


def test_oversized_model_is_rejected_before_parsing():
    report = run(b.valid_bundle(), limits=Limits(max_model_bytes=100))
    assert failed_ids(report) == ["V2"]
    assert check(report, "V1")["passed"] is None


# ---------------------------------------------------------------------------- SEC-5 checksum


def test_bytes_changed_since_ingest_fail_v11_and_nothing_is_parsed():
    bundle = b.valid_bundle()
    hashes = {**bundle.hashes, "model": "0" * 64}
    report = validate_bundle(bundle.model, bundle.signature, bundle.golden, hashes)
    assert failed_ids(report) == ["V11"]
    assert all(c["passed"] is None for c in report["checks"] if c["id"] != "V11")


# ---------------------------------------------------------------------------- other checks


def test_v5_old_opset_is_rejected():
    report = run(b.make_bundle(b.logistic_model(opset=9)))
    assert check(report, "V5")["passed"] is False
    assert "opset 9" in check(report, "V5")["detail"]


@pytest.mark.parametrize(
    ("sig", "fragment"),
    [
        (b.signature(dtype="int64"), "dtype int64"),
        (b.signature(width=5), "dim 1 is 5"),
        (
            {**b.signature(), "outputs": [{"name": "score", "dtype": "float32", "shape": [-1]}]},
            "'score'",
        ),
        (
            {**b.signature(), "inputs": [{**b.signature()["inputs"][0], "name": "x"}]},
            "inputs ['x']",
        ),
    ],
)
def test_v7_signature_must_match_the_graph(sig, fragment):
    data = b.logistic_model().SerializeToString()
    report = run(b.make_bundle(data, sig=sig, golden=b.golden_for(data)))
    v7 = check(report, "V7")
    assert v7["passed"] is False and fragment in v7["detail"], v7


def test_v9_tampered_golden_probabilities_fail():
    data = b.logistic_model().SerializeToString()
    golden = b.golden_for(data)
    golden["outputs"]["probabilities"][0][0] += 0.01
    report = run(b.make_bundle(data, golden=golden))
    assert failed_ids(report) == ["V9"]
    assert "max |diff|" in check(report, "V9")["detail"]


def test_v9_flipped_golden_label_fails():
    data = b.logistic_model().SerializeToString()
    golden = b.golden_for(data)
    golden["outputs"]["label"][0] = 1 - golden["outputs"]["label"][0]
    assert failed_ids(run(b.make_bundle(data, golden=golden))) == ["V9"]


def test_v9_tolerance_cannot_be_loosened_by_the_bundle():
    data = b.logistic_model().SerializeToString()
    golden = b.golden_for(data)
    golden["outputs"]["probabilities"][0][0] += 0.01
    golden["tolerance"]["probabilities"] = 1.0  # attacker asks for "anything goes"
    assert failed_ids(run(b.make_bundle(data, golden=golden))) == ["V9"]


def test_v8_wall_clock_limit_kills_the_sandbox():
    report = run(b.valid_bundle(), sandbox=SandboxLimits(wall_seconds=0.01))
    assert check(report, "V8")["passed"] is False
    assert "time limit" in check(report, "V8")["detail"]


@pytest.mark.skipif(sys.platform == "win32", reason="memory accounting needs Linux rlimits/rusage")
def test_v8_memory_budget_is_enforced():
    report = run(b.valid_bundle(), limits=Limits(max_rss_mb=1))
    assert check(report, "V8")["passed"] is False
    assert "peak memory" in check(report, "V8")["detail"]
    assert report["facts"]["rlimitsEnforced"] is True


def test_v10_latency_budget():
    report = run(b.valid_bundle(), limits=Limits(max_p95_ms=0.000001))
    assert failed_ids(report) == ["V10"]


def test_invalid_json_in_bundle_is_rejected():
    bundle = b.valid_bundle()
    broken = b.Bundle(bundle.model, b"{not json", bundle.golden)
    report = run(broken)
    assert check(report, "V7")["passed"] is False


def test_report_is_json_serializable():
    json.dumps(run(b.valid_bundle()))
