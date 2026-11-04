"""Model B: PyTorch MLP with normalization inside `forward` -> ONNX (torch.export-based exporter).

    uv run --directory ml python -m modelops_ml.train_pytorch --experiment modelops/<org>/<project>

Same signature as model A (features -> label, probabilities), so the two can be compared,
canaried and rolled back against each other in later milestones.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
import onnx
import torch
from torch import nn

from .bundle import (
    INPUT_NAME,
    OUTPUT_LABEL,
    OUTPUT_PROBABILITIES,
    build_signature,
    onnx_predict,
    write_bundle,
)
from .common import (
    Timer,
    TrainResult,
    base_parser,
    classification_metrics,
    load_split,
    parity,
    run_cli,
)
from .datasets import FEATURES, ChurnParams

FRAMEWORK = "PYTORCH_ONNX"
PARITY_TOLERANCE = 1e-5


class ChurnMLP(nn.Module):
    """Input normalization is a buffer in the module, so the exported graph includes it."""

    def __init__(self, mean: np.ndarray, std: np.ndarray, hidden: tuple[int, int] = (32, 16)):
        super().__init__()
        self.register_buffer("mean", torch.tensor(mean, dtype=torch.float32))
        self.register_buffer("std", torch.tensor(np.where(std > 0, std, 1.0), dtype=torch.float32))
        self.net = nn.Sequential(
            nn.Linear(len(FEATURES), hidden[0]),
            nn.ReLU(),
            nn.Linear(hidden[0], hidden[1]),
            nn.ReLU(),
            nn.Linear(hidden[1], 2),
        )

    def logits(self, x: torch.Tensor) -> torch.Tensor:
        return self.net((x - self.mean) / self.std)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        probabilities = torch.softmax(self.logits(x), dim=1)
        return torch.argmax(probabilities, dim=1), probabilities


def train(
    params: ChurnParams,
    out_dir: Path,
    epochs: int = 25,
    lr: float = 1e-3,
    batch_size: int = 256,
) -> TrainResult:
    torch.manual_seed(params.seed)
    torch.use_deterministic_algorithms(True)
    split = load_split(params)
    model = ChurnMLP(split.x_train.mean(axis=0), split.x_train.std(axis=0))
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.CrossEntropyLoss()

    x_train, y_train = torch.from_numpy(split.x_train), torch.from_numpy(split.y_train)
    x_test, y_test = torch.from_numpy(split.x_test), torch.from_numpy(split.y_test)
    generator = torch.Generator().manual_seed(params.seed)
    series: dict[str, list[float]] = {"train_loss": [], "val_loss": []}

    with Timer() as timer:
        for _ in range(epochs):
            model.train()
            order = torch.randperm(len(x_train), generator=generator)
            total = 0.0
            for i in range(0, len(order), batch_size):
                idx = order[i : i + batch_size]
                optimizer.zero_grad()
                loss = loss_fn(model.logits(x_train[idx]), y_train[idx])
                loss.backward()
                optimizer.step()
                total += float(loss) * len(idx)
            model.eval()
            with torch.no_grad():
                series["val_loss"].append(float(loss_fn(model.logits(x_test), y_test)))
            series["train_loss"].append(total / len(x_train))

    model.eval()
    onnx_path = out_dir / "export.onnx"
    out_dir.mkdir(parents=True, exist_ok=True)
    batch = torch.export.Dim("batch", min=1, max=4096)
    torch.onnx.export(
        model,
        (x_test[:2],),
        str(onnx_path),
        input_names=[INPUT_NAME],
        output_names=[OUTPUT_LABEL, OUTPUT_PROBABILITIES],
        dynamic_shapes={"x": {0: batch}},
        dynamo=True,
        external_data=False,
        verbose=False,
    )
    onnx_model = onnx.load(str(onnx_path), load_external_data=False)
    onnx_model.graph.name = "modelops_churn_mlp"
    onnx_path.unlink()

    signature = build_signature(FEATURES, classes=[0, 1])
    bundle = write_bundle(
        out_dir,
        onnx_model,
        signature,
        golden_inputs=split.x_test[:16],
        metadata={"modelops.framework": FRAMEWORK, "modelops.dataset.sha256": split.dataset_sha256},
    )

    with torch.no_grad():
        _, native = model(x_test)
    _, exported = onnx_predict((out_dir / "model.onnx").read_bytes(), split.x_test)
    diff = parity(native.numpy(), exported)
    if diff > PARITY_TOLERANCE:
        raise RuntimeError(f"ONNX export differs from the trained model by {diff:.2e}")

    return TrainResult(
        framework=FRAMEWORK,
        bundle=bundle,
        metrics={
            **classification_metrics(split.y_test, native.numpy()[:, 1]),
            "parity_max_abs_diff": diff,
        },
        hyperparams={
            "model": "MLP(6-32-16-2)",
            "epochs": str(epochs),
            "lr": str(lr),
            "batch_size": str(batch_size),
            "optimizer": "Adam",
            "preprocessing": "standardize (in graph)",
        },
        split=split,
        series=series,
        train_seconds=timer.seconds,
    )


def main(argv: list[str] | None = None) -> None:
    parser = base_parser(__doc__ or "")
    parser.add_argument("--epochs", type=int, default=25)
    parser.add_argument("--lr", type=float, default=1e-3)
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory() as tmp:
        result = train(
            ChurnParams(n_rows=args.rows, seed=args.seed),
            args.out or Path(tmp) / "model",
            epochs=args.epochs,
            lr=args.lr,
        )
        run_cli(args, result, default_run_name=f"pytorch-mlp-e{args.epochs}")


if __name__ == "__main__":
    main(sys.argv[1:])
