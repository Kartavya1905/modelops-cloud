"""Validation checks V1-V10 for an ONNX bundle (V11, the checksum, runs before these in app.py).

Every function here is pure: bytes / parsed objects in, a CheckResult out. The functions that
parse or run the model (V1, V3, V8-V10) are only ever called inside the sandboxed child
process (sandbox.py), never in the web server process.

Check ids are stable: they appear in API responses, the UI checklist and the tests.
"""

from __future__ import annotations

import json
import statistics
import time
from collections.abc import Iterator
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np
import onnx
from onnx import TensorProto

ALLOWED_DOMAINS = frozenset({"", "ai.onnx", "ai.onnx.ml"})
OPSET_RANGES = {"ai.onnx": (13, onnx.defs.onnx_opset_version()), "ai.onnx.ml": (1, 5)}

# signature dtype -> ONNX element type
DTYPES = {
    "float32": TensorProto.FLOAT,
    "float64": TensorProto.DOUBLE,
    "int32": TensorProto.INT32,
    "int64": TensorProto.INT64,
    "bool": TensorProto.BOOL,
}
NP_DTYPES = {"float32": np.float32, "float64": np.float64, "int32": np.int32, "int64": np.int64}

CHECKS = {
    "V1": "Format: an ONNX protobuf, not a pickle or archive",
    "V2": "Size limits",
    "V3": "ONNX checker (full)",
    "V4": "No external data references",
    "V5": "Opset versions within the supported range",
    "V6": "Only allow-listed operator domains",
    "V7": "Signature matches the graph",
    "V8": "Loads within time and memory budget",
    "V9": "Golden examples reproduce exactly",
    "V10": "Single-row latency budget",
    "V11": "SHA-256 matches the stored artifact",
}


@dataclass
class Limits:
    max_model_bytes: int = 100 * 1024 * 1024
    max_json_bytes: int = 1024 * 1024
    max_load_ms: float = 10_000
    max_rss_mb: float = 512
    max_p95_ms: float = 50
    max_golden_tolerance: float = 1e-4


@dataclass
class CheckResult:
    id: str
    passed: bool | None  # None = skipped
    detail: str
    name: str = ""

    def __post_init__(self) -> None:
        self.name = CHECKS[self.id]


@dataclass
class Report:
    checks: list[CheckResult] = field(default_factory=list)
    facts: dict[str, Any] = field(default_factory=dict)

    def add(self, check: CheckResult) -> CheckResult:
        self.checks.append(check)
        return check

    def skip_remaining(self, ids: list[str], reason: str) -> None:
        done = {c.id for c in self.checks}
        for cid in ids:
            if cid not in done:
                self.checks.append(CheckResult(cid, None, f"skipped: {reason}"))

    @property
    def result(self) -> str:
        if any(c.passed is False for c in self.checks):
            return "FAILED"
        return "PASSED"

    def to_dict(self) -> dict[str, Any]:
        order = list(CHECKS)
        checks = sorted(self.checks, key=lambda c: order.index(c.id))
        return {"result": self.result, "checks": [asdict(c) for c in checks], "facts": self.facts}


# ---------------------------------------------------------------------------- V1 / V2


def looks_like_pickle_or_archive(data: bytes) -> str | None:
    """Magic-byte sniffing. Informational: V1 fails anyway because these don't parse as ONNX."""
    if data[:1] == b"\x80" and len(data) > 1 and data[1] <= 5:
        return f"pickle protocol {data[1]} stream"
    if data[:4] == b"PK\x03\x04":
        return "zip archive (e.g. a PyTorch .pt checkpoint, which contains pickle)"
    if data[:2] in (b"(d", b"(l", b"cc") or data.startswith(
        (b"cos\n", b"cbuiltins\n", b"cposix\n")
    ):
        return "pickle protocol 0/1 stream"
    return None


def check_format(data: bytes) -> tuple[CheckResult, onnx.ModelProto | None]:
    sniff = looks_like_pickle_or_archive(data)
    if sniff:
        return CheckResult("V1", False, f"rejected without loading: looks like a {sniff}"), None
    try:
        # Raw protobuf deserialization: never executes code and never opens other files
        # (external-data references are just strings at this point; V4 rejects them).
        model = onnx.ModelProto.FromString(data)
    except Exception as exc:
        return CheckResult("V1", False, f"not a parseable ONNX model: {type(exc).__name__}"), None
    if not model.HasField("graph") or len(model.graph.node) == 0:
        return CheckResult("V1", False, "ONNX model has no graph nodes"), None
    if model.ir_version < 7:
        return CheckResult(
            "V1", False, f"IR version {model.ir_version} is too old (need >= 7)"
        ), None
    return CheckResult(
        "V1", True, f"ONNX IR v{model.ir_version}, {len(model.graph.node)} nodes"
    ), model


def check_sizes(model_size: int, json_sizes: dict[str, int], limits: Limits) -> CheckResult:
    if model_size > limits.max_model_bytes:
        return CheckResult(
            "V2", False, f"model is {model_size} bytes (max {limits.max_model_bytes})"
        )
    for name, size in json_sizes.items():
        if size > limits.max_json_bytes:
            return CheckResult("V2", False, f"{name} is {size} bytes (max {limits.max_json_bytes})")
    return CheckResult("V2", True, f"model {model_size} bytes")


# ---------------------------------------------------------------------------- V3 / V4


def check_checker(model: onnx.ModelProto) -> CheckResult:
    try:
        onnx.checker.check_model(model, full_check=True)
    except Exception as exc:
        return CheckResult("V3", False, f"onnx.checker: {str(exc).splitlines()[0][:300]}")
    return CheckResult("V3", True, "valid")


def _graphs(graph: onnx.GraphProto) -> Iterator[onnx.GraphProto]:
    """The graph and every subgraph nested in node attributes (If/Loop/Scan bodies)."""
    yield graph
    for node in graph.node:
        for attr in node.attribute:
            if attr.type == onnx.AttributeProto.GRAPH:
                yield from _graphs(attr.g)
            elif attr.type == onnx.AttributeProto.GRAPHS:
                for g in attr.graphs:
                    yield from _graphs(g)


def _tensors(model: onnx.ModelProto) -> Iterator[onnx.TensorProto]:
    for graph in _graphs(model.graph):
        yield from graph.initializer
        for sparse in graph.sparse_initializer:
            yield sparse.values
            yield sparse.indices
        for node in graph.node:
            for attr in node.attribute:
                if attr.type == onnx.AttributeProto.TENSOR:
                    yield attr.t
                elif attr.type == onnx.AttributeProto.TENSORS:
                    yield from attr.tensors


def check_external_data(model: onnx.ModelProto) -> CheckResult:
    """External data makes the runtime open other files by path, a path-traversal vector."""
    refs = []
    for t in _tensors(model):
        if t.data_location == TensorProto.EXTERNAL or len(t.external_data) > 0:
            location = next((e.value for e in t.external_data if e.key == "location"), "?")
            refs.append(f"{t.name or '<unnamed>'} -> {location!r}")
    if refs:
        return CheckResult("V4", False, f"external data references: {', '.join(refs[:5])}")
    return CheckResult("V4", True, "all weights embedded")


# ---------------------------------------------------------------------------- V5 / V6


def check_opsets(model: onnx.ModelProto) -> CheckResult:
    local = {f.domain for f in model.functions}
    seen = {}
    for op in model.opset_import:
        domain = op.domain or "ai.onnx"
        seen[domain] = op.version
        if domain in OPSET_RANGES:
            lo, hi = OPSET_RANGES[domain]
            if not lo <= op.version <= hi:
                return CheckResult("V5", False, f"{domain} opset {op.version} outside {lo}-{hi}")
        elif domain not in local:
            # Unknown domains are reported precisely by V6; here only versions are judged.
            continue
    if "ai.onnx" not in seen:
        return CheckResult("V5", False, "no default (ai.onnx) opset imported")
    return CheckResult("V5", True, ", ".join(f"{d} {v}" for d, v in sorted(seen.items())))


def operators(model: onnx.ModelProto) -> set[tuple[str, str]]:
    ops = set()
    for graph in _graphs(model.graph):
        ops |= {(n.domain or "", n.op_type) for n in graph.node}
    for fn in model.functions:
        ops |= {(n.domain or "", n.op_type) for n in fn.node}
    return ops


def check_domains(model: onnx.ModelProto) -> CheckResult:
    """Custom domains would require native custom-op libraries: arbitrary code. Never allowed.

    Model-local functions (e.g. emitted by the PyTorch exporter) are allowed because their bodies
    are themselves graphs of allow-listed operators, checked here too.
    """
    local = {(f.domain, f.name) for f in model.functions}
    bad = sorted(
        f"{d}:{op}"
        for d, op in operators(model)
        if d not in ALLOWED_DOMAINS and (d, op) not in local
    )
    if bad:
        return CheckResult("V6", False, f"operators outside the allow-list: {', '.join(bad[:8])}")
    return CheckResult("V6", True, f"{len(operators(model))} operator types, all allow-listed")


# ---------------------------------------------------------------------------- V7


def _value_info(model: onnx.ModelProto, which: str) -> dict[str, onnx.ValueInfoProto]:
    initializers = {i.name for i in model.graph.initializer}
    values = model.graph.input if which == "input" else model.graph.output
    return {v.name: v for v in values if v.name not in initializers}


def _check_tensor(spec: dict[str, Any], info: onnx.ValueInfoProto) -> str | None:
    tensor = info.type.tensor_type
    want = DTYPES.get(spec["dtype"])
    if tensor.elem_type != want:
        got = TensorProto.DataType.Name(tensor.elem_type)
        return f"{spec['name']}: dtype {spec['dtype']} but graph has {got}"
    dims = tensor.shape.dim
    if len(dims) != len(spec["shape"]):
        return f"{spec['name']}: rank {len(spec['shape'])} but graph has rank {len(dims)}"
    for i, (want_dim, dim) in enumerate(zip(spec["shape"], dims, strict=True)):
        if want_dim >= 0 and dim.HasField("dim_value") and dim.dim_value != want_dim:
            return f"{spec['name']}: dim {i} is {want_dim} but graph has {dim.dim_value}"
    return None


def check_signature(model: onnx.ModelProto, signature: dict[str, Any]) -> CheckResult:
    inputs = _value_info(model, "input")
    outputs = _value_info(model, "output")
    want_inputs = [i["name"] for i in signature["inputs"]]
    if want_inputs != list(inputs):
        return CheckResult("V7", False, f"inputs {want_inputs} != graph inputs {list(inputs)}")
    for spec in signature["inputs"]:
        problem = _check_tensor(spec, inputs[spec["name"]])
        if problem:
            return CheckResult("V7", False, problem)
    for spec in signature["outputs"]:
        if spec["name"] not in outputs:
            return CheckResult("V7", False, f"output {spec['name']!r} is not produced by the graph")
        problem = _check_tensor(spec, outputs[spec["name"]])
        if problem:
            return CheckResult("V7", False, problem)
    return CheckResult(
        "V7", True, f"{len(want_inputs)} input(s), {len(signature['outputs'])} output(s)"
    )


# ---------------------------------------------------------------------------- V8-V10 (child only)


def run_session_checks(
    model_bytes: bytes, signature: dict[str, Any], golden: dict[str, Any], limits: Limits
) -> tuple[list[CheckResult], dict[str, Any]]:
    """Loads the model with ONNX Runtime and replays golden examples. Child process only."""
    import onnxruntime as ort

    facts: dict[str, Any] = {"onnxruntime": ort.__version__}
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    # Belt and braces: never allow custom-op libraries to be registered.
    started = time.perf_counter()
    session = ort.InferenceSession(
        model_bytes, sess_options=opts, providers=["CPUExecutionProvider"]
    )
    load_ms = (time.perf_counter() - started) * 1000
    facts["loadMs"] = round(load_ms, 1)
    results = []
    if load_ms > limits.max_load_ms:
        results.append(
            CheckResult("V8", False, f"load took {load_ms:.0f} ms (max {limits.max_load_ms:.0f})")
        )
    else:
        results.append(CheckResult("V8", True, f"loaded in {load_ms:.0f} ms"))

    # ---- V9 golden examples
    if len(signature["inputs"]) != 1:
        results.append(CheckResult("V9", False, "golden replay supports exactly one input tensor"))
        results.append(CheckResult("V10", None, "skipped: no golden inputs"))
        return results, facts
    spec = signature["inputs"][0]
    try:
        x = np.asarray(golden["inputs"], dtype=NP_DTYPES[spec["dtype"]])
        expected: dict[str, Any] = golden["outputs"]
    except Exception as exc:
        results.append(CheckResult("V9", False, f"golden_examples.json is malformed: {exc}"))
        results.append(CheckResult("V10", None, "skipped: no golden inputs"))
        return results, facts
    if x.ndim != len(spec["shape"]) or len(x) == 0:
        results.append(CheckResult("V9", False, f"golden inputs have shape {x.shape}"))
        results.append(CheckResult("V10", None, "skipped: no golden inputs"))
        return results, facts

    names = [o["name"] for o in signature["outputs"]]
    produced = dict(zip(names, session.run(names, {spec["name"]: x}), strict=True))
    tolerance = float((golden.get("tolerance") or {}).get("probabilities", 1e-5))
    tolerance = min(tolerance, limits.max_golden_tolerance)
    worst = 0.0
    problem = None
    for name in names:
        if name not in expected:
            problem = f"golden examples have no expected values for output {name!r}"
            break
        got = np.asarray(produced[name])
        want = np.asarray(expected[name])
        if got.shape != want.shape:
            problem = f"{name}: shape {got.shape} != expected {want.shape}"
            break
        if np.issubdtype(got.dtype, np.integer) or got.dtype == np.bool_:
            if not np.array_equal(got, want):
                problem = f"{name}: {int(np.sum(got != want))} value(s) differ"
                break
        else:
            diff = float(np.max(np.abs(got.astype(np.float64) - want.astype(np.float64))))
            worst = max(worst, diff)
            if diff > tolerance:
                problem = f"{name}: max |diff| {diff:.2e} > tolerance {tolerance:.0e}"
                break
    facts["goldenRows"] = len(x)
    facts["goldenMaxAbsDiff"] = worst
    results.append(
        CheckResult("V9", False, problem)
        if problem
        else CheckResult("V9", True, f"{len(x)} rows reproduce (max |diff| {worst:.1e})")
    )

    # ---- V10 latency (single row, after warm-up)
    row = x[:1]
    for _ in range(5):
        session.run(names, {spec["name"]: row})
    samples = []
    for _ in range(40):
        t0 = time.perf_counter()
        session.run(names, {spec["name"]: row})
        samples.append((time.perf_counter() - t0) * 1000)
    p50 = statistics.median(samples)
    p95 = statistics.quantiles(samples, n=20)[18]
    facts["latencyP50Ms"] = round(p50, 3)
    facts["latencyP95Ms"] = round(p95, 3)
    results.append(
        CheckResult("V10", False, f"p95 {p95:.2f} ms > {limits.max_p95_ms:.0f} ms")
        if p95 > limits.max_p95_ms
        else CheckResult("V10", True, f"p50 {p50:.2f} ms, p95 {p95:.2f} ms")
    )
    return results, facts


def parse_json(data: bytes, what: str) -> tuple[dict[str, Any] | None, str | None]:
    try:
        value = json.loads(data.decode("utf-8"))
    except Exception:
        return None, f"{what} is not valid UTF-8 JSON"
    if not isinstance(value, dict):
        return None, f"{what} must be a JSON object"
    return value, None
