"""Trains both demo models on small data and checks the exported ONNX bundles.

These are the guarantees the platform relies on from trusted training code:
parity with the native model, a signature that matches the graph, golden examples that replay
exactly, no external data, and only allow-listed operator domains.
"""

import json

import numpy as np
import onnx
import pytest

from modelops_ml import train_pytorch, train_sklearn
from modelops_ml.bundle import ALLOWED_DOMAINS, GOLDEN_TOLERANCE, onnx_predict
from modelops_ml.common import lineage_tags
from modelops_ml.datasets import FEATURES, ChurnParams

PARAMS = ChurnParams(n_rows=3000, seed=21)


@pytest.fixture(scope="module")
def sklearn_result(tmp_path_factory):
    return train_sklearn.train(PARAMS, tmp_path_factory.mktemp("sk") / "model", n_estimators=60)


@pytest.fixture(scope="module")
def pytorch_result(tmp_path_factory):
    return train_pytorch.train(PARAMS, tmp_path_factory.mktemp("pt") / "model", epochs=6)


@pytest.fixture(params=["sklearn", "pytorch"])
def result(request, sklearn_result, pytorch_result):
    return sklearn_result if request.param == "sklearn" else pytorch_result


def test_bundle_contains_exactly_the_three_files(result):
    assert sorted(p.name for p in result.bundle.directory.iterdir()) == [
        "golden_examples.json",
        "model.onnx",
        "signature.json",
    ]


def test_onnx_matches_the_native_model(result):
    assert result.metrics["parity_max_abs_diff"] <= 1e-5


def test_model_is_useful(result):
    assert result.metrics["test_roc_auc"] > 0.75
    assert result.metrics["test_accuracy"] > 0.75


def test_signature_matches_graph_and_feature_order(result):
    model = onnx.load(str(result.bundle.directory / "model.onnx"), load_external_data=False)
    sig = json.loads((result.bundle.directory / "signature.json").read_text())
    assert [i.name for i in model.graph.input] == ["features"]
    assert sorted(o.name for o in model.graph.output) == ["label", "probabilities"]
    assert sig["inputs"][0]["features"] == list(FEATURES)
    assert sig["inputs"][0]["shape"] == [-1, len(FEATURES)]


def test_no_external_data_and_only_allowed_domains(result):
    model = onnx.load(str(result.bundle.directory / "model.onnx"), load_external_data=False)
    onnx.checker.check_model(model, full_check=True)
    for tensor in model.graph.initializer:
        assert tensor.data_location != onnx.TensorProto.EXTERNAL
    local_functions = {f.domain for f in model.functions}
    node_domains = {n.domain for n in model.graph.node} - local_functions
    assert node_domains <= ALLOWED_DOMAINS


def test_golden_examples_replay_with_onnx_runtime(result):
    golden = json.loads((result.bundle.directory / "golden_examples.json").read_text())
    labels, probs = onnx_predict(
        (result.bundle.directory / "model.onnx").read_bytes(),
        np.asarray(golden["inputs"], dtype=np.float32),
    )
    assert labels.tolist() == golden["outputs"]["label"]
    assert (
        np.max(np.abs(probs - np.asarray(golden["outputs"]["probabilities"]))) <= GOLDEN_TOLERANCE
    )


def test_batch_of_one_and_large_batch_both_work(result):
    model = (result.bundle.directory / "model.onnx").read_bytes()
    x = result.split.x_test
    assert onnx_predict(model, x[:1])[1].shape == (1, 2)
    assert onnx_predict(model, x[:500])[1].shape == (500, 2)


def test_lineage_tags_reference_the_dataset_version(result):
    tags = lineage_tags(result)
    assert tags["modelops.dataset.sha256"] == result.split.dataset_sha256
    assert tags["modelops.dataset.version"] == "seed21-n3000"
    assert tags["modelops.bundle.sha256"] == result.bundle.sha256
    assert tags["modelops.framework"] in {"SKLEARN_ONNX", "PYTORCH_ONNX"}


def test_onnx_metadata_records_framework_and_dataset(result):
    model = onnx.load(str(result.bundle.directory / "model.onnx"), load_external_data=False)
    meta = {p.key: p.value for p in model.metadata_props}
    assert meta["modelops.framework"] == result.framework
    assert meta["modelops.dataset.sha256"] == result.split.dataset_sha256


def test_sklearn_training_is_reproducible(tmp_path, sklearn_result):
    again = train_sklearn.train(PARAMS, tmp_path / "model", n_estimators=60)
    assert again.bundle.sha256 == sklearn_result.bundle.sha256


def test_pytorch_records_per_epoch_loss_curves(pytorch_result):
    assert len(pytorch_result.series["train_loss"]) == 6
    assert pytorch_result.series["train_loss"][-1] < pytorch_result.series["train_loss"][0]
