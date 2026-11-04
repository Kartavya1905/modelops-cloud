# ADR-0002 — Serve only validated ONNX graphs; preprocessing lives inside the graph

- **Status:** Accepted
- **Date:** 2026-11-03

## Context
Pickle-based formats (`.pkl`, `joblib`, PyTorch `.pt`) can execute arbitrary code when loaded. Custom serving code per model is also a major source of training/serving skew and of security holes.

## Decision
- The serving runtime loads **only ONNX** files, which are declarative graphs executed by ONNX Runtime.
- Trusted training code converts models: scikit-learn → `skl2onnx`; PyTorch → `torch.onnx.export`.
- **Preprocessing is part of the exported graph** (sklearn `Pipeline` with scalers/encoders; normalization inside the PyTorch module's `forward`).
- Operator domains are allow-listed (`ai.onnx`, `ai.onnx.ml`); external data and custom op libraries are rejected.
- Each bundle ships `signature.json` and `golden_examples.json` so the platform can check the model functionally.

## Consequences
- ➕ No code execution on model load; one generic serving image for every model.
- ➕ Training/serving skew eliminated for supported preprocessing.
- ➖ Only models and preprocessing that convert to ONNX are supported (no arbitrary Python feature engineering at serving time). This is an accepted, documented limitation.
- ➖ Converter version coupling (risk R6) needs parity tests.

## Alternatives considered
- **MLflow pyfunc serving:** rejected because it runs arbitrary Python from the artifact.
- **Pickle plus "trusted uploader":** rejected, because trust in the uploader is not a technical control.
- **safetensors + custom code:** rejected, because the code part is the problem.
