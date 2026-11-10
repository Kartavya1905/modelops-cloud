import numpy as np
import pytest

from modelops_ml.datasets import (
    FEATURES,
    LABEL,
    ChurnParams,
    features_and_label,
    generate,
    generator_params,
    sha256_of,
)

SMALL = ChurnParams(n_rows=4000, seed=11)


def test_same_params_give_byte_identical_data():
    assert sha256_of(generate(SMALL)) == sha256_of(generate(SMALL))


def test_known_hash_is_stable_across_machines():
    # Pinned so that a numpy/pandas upgrade (or an OS difference) that changes the data is caught.
    # If this fails after a deliberate dependency upgrade, bump GENERATOR_VERSION and update it.
    assert sha256_of(generate(ChurnParams(n_rows=200, seed=1))) == KNOWN_SHA


def test_different_seed_gives_different_data():
    assert sha256_of(generate(SMALL)) != sha256_of(generate(ChurnParams(n_rows=4000, seed=12)))


def test_schema_ranges_and_label_rate():
    df = generate(SMALL)
    assert list(df.columns) == [*FEATURES, LABEL]
    assert df["tenure_months"].between(0, 72).all()
    assert df["monthly_charges"].between(18, 160).all()
    assert set(df["contract_type"].unique()) <= {0, 1, 2}
    assert set(df[LABEL].unique()) == {0, 1}
    assert 0.15 < df[LABEL].mean() < 0.45  # realistic, learnable class balance


def test_data_drift_knobs_move_input_distributions():
    base = generate(SMALL)
    shifted = generate(ChurnParams(n_rows=4000, seed=11, charge_shift=25.0, usage_scale=0.6))
    assert shifted["monthly_charges"].mean() > base["monthly_charges"].mean() + 15
    assert shifted["usage_hours"].mean() < base["usage_hours"].mean() * 0.8


def test_concept_drift_reverses_the_tickets_to_churn_relationship():
    def ticket_corr(concept_shift: float) -> float:
        df = generate(ChurnParams(n_rows=20_000, seed=3, concept_shift=concept_shift))
        return float(np.corrcoef(df["support_tickets"], df[LABEL])[0, 1])

    assert ticket_corr(0.0) > 0.1
    assert ticket_corr(1.0) < ticket_corr(0.0) - 0.15


def test_concept_drift_leaves_inputs_unchanged():
    # Concept drift changes labels only, which is why input-based drift detection cannot see it.
    a = generate(ChurnParams(n_rows=4000, seed=5))
    b = generate(ChurnParams(n_rows=4000, seed=5, concept_shift=1.0))
    assert a[list(FEATURES)].equals(b[list(FEATURES)])
    assert not a[LABEL].equals(b[LABEL])


def test_generator_params_record_everything_needed_to_regenerate():
    p = generator_params(SMALL)
    assert p["dataset.seed"] == "11"
    assert p["dataset.n_rows"] == "4000"
    assert p["dataset.generator"] == "churn-v2"
    assert "dataset.numpy" in p


def test_features_matrix_is_float32_in_signature_order():
    x, y = features_and_label(generate(SMALL))
    assert x.dtype == np.float32 and x.shape == (4000, len(FEATURES))
    assert y.dtype == np.int64


@pytest.mark.parametrize("bad", [{"n_rows": 5}, {"concept_shift": 1.5}, {"usage_scale": 0}])
def test_invalid_params_are_rejected(bad):
    with pytest.raises(ValueError):
        ChurnParams(**bad)


# n_rows=200, seed=1 (recorded on Windows 11; must match on Linux CI)
KNOWN_SHA = "1bb5bb94d3c09311ef45b7d699479ec5c0dfe985ee0e4cf5016a9cd78c512670"


def test_cli_exports_the_exact_dataset_version(tmp_path, capsys) -> None:
    """M7: the platform stores datasets by SHA-256; the CLI must produce the same bytes."""
    import json

    from modelops_ml.datasets import ChurnParams, generate, main, sha256_of

    out = tmp_path / "holdout.csv"
    assert main(["--rows", "300", "--seed", "11", "--out", str(out)]) == 0
    expected = sha256_of(generate(ChurnParams(n_rows=300, seed=11)))
    import hashlib

    assert hashlib.sha256(out.read_bytes()).hexdigest() == expected
    assert f"sha256={expected}" in capsys.readouterr().err

    jsonl = tmp_path / "rows.jsonl"
    main(
        [
            "--rows",
            "20",
            "--seed",
            "11",
            "--concept-shift",
            "1",
            "--format",
            "jsonl",
            "--out",
            str(jsonl),
        ]
    )
    rows = [json.loads(line) for line in jsonl.read_text().splitlines()]
    assert len(rows) == 20
    assert set(rows[0]) == {"features", "label"}
    assert rows[0]["label"] in (0, 1)


def test_concept_drift_changes_labels_but_not_inputs() -> None:
    """M7: concept drift must be invisible to input-drift detection by construction."""
    from modelops_ml.datasets import FEATURES, LABEL, ChurnParams, generate

    normal = generate(ChurnParams(n_rows=2000, seed=21))
    concept = generate(ChurnParams(n_rows=2000, seed=21, concept_shift=1.0))
    assert normal[list(FEATURES)].equals(concept[list(FEATURES)])  # identical inputs
    flipped = (normal[LABEL] != concept[LABEL]).mean()
    assert flipped > 0.2  # the relationship to the label really changed
