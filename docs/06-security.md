# 06 — Security Design and Model Artifact Security Strategy

> Status: **Design (Phase 0)**. Each control lists the test that will prove it (M4, M9).

## 1. Threat model (summary)

| Asset | Threat | Control |
|---|---|---|
| Inference runtime | Malicious artifact runs code on load (pickle `__reduce__`, custom ops, external data path traversal) | ONNX-only, operator-domain allow-list, no external data, no custom op libraries, sandboxed validation |
| Inference runtime | Resource exhaustion (huge model, decompression bomb, giant batch) | Size limits, load-time memory and time budget in validation, batch ≤ 64, CPU/memory/pids limits |
| Tenant data | Cross-tenant read or write (IDOR) | `org_id` on every row, membership guard, scoped queries, 404 on mismatch, Postgres RLS (Tier 3) |
| Accounts | Credential stuffing, session theft, CSRF | Argon2id, login rate limit, httpOnly SameSite cookies, CSRF token header, session rotation |
| API keys | Leakage from the database or logs | Only an HMAC-SHA256 of the secret is stored; secret shown once; redacted in logs; scoped, revocable, expiring |
| Docker host | Orchestrator compromise → host takeover | Socket **proxy** exposing only container endpoints; no `privileged`, no host mounts, no host network for model servers |
| Supply chain | Vulnerable dependencies or images | Lockfiles, `pnpm audit`, `pip-audit`, Trivy image and filesystem scan, Dependabot, pinned base-image digests |
| Secrets | Secrets committed to git | `.env` gitignored, `.env.example` only, gitleaks in CI and pre-commit |
| Customer inputs | Sensitive inputs leaked via logs | Bodies never logged; input capture opt-in per endpoint; 7-day retention |
| Audit trail | Tampering to hide actions | Append-only trigger, no UPDATE/DELETE grant, hash chain (Tier 3) |

## 2. Model artifact security strategy

### 2.1 What we accept

| Accepted | Rejected (always) |
|---|---|
| `model.onnx` (ONNX protobuf) | `.pkl`, `.pickle`, `.joblib`, `.pt`/`.pth` (pickle-based), `.h5`, `.zip` / archives, any executable or script |
| `signature.json` (JSON, schema-validated) | ONNX models with **external data** references |
| `golden_examples.json` (inputs + expected outputs) | Operator domains other than `""` / `ai.onnx` and `ai.onnx.ml` |
| — | Models needing custom op libraries (`.so` / `.dll`) |

**Why ONNX:** an ONNX file is a *declarative computation graph* executed by ONNX Runtime, not a program. Loading it does not run Python. Trusted training code converts scikit-learn (`skl2onnx`) and PyTorch (`torch.onnx.export`) models to ONNX *before* upload, so pickle never crosses the trust boundary ([ADR-0002](adr/0002-onnx-only-serving.md)).

**Preprocessing lives inside the graph** (StandardScaler / one-hot in the sklearn `Pipeline`, normalization in the PyTorch `forward`). The serving runtime therefore has *no* custom preprocessing code. This removes both a code-execution vector and the training/serving skew problem.

### 2.2 Upload pipeline

```text
1. Client asks for upload URLs → API checks role + quota → presigned PUT URLs to
   uploads-staging/<org>/<upload-id>/ (10 min TTL, Content-Length ≤ 100 MB, exact keys only)
2. Client uploads the three files directly to storage (API never buffers large bodies)
3. Client calls "finalise" → API:
     a. HEAD each object, enforce size limits
     b. streams the object and computes SHA-256 server-side (client-supplied hashes are never trusted)
     c. copies to model-artifacts/sha256/<hash>/... (content-addressed, immutable)
     d. creates model_version(PENDING_VALIDATION) + outbox(VALIDATE) in one tx
4. Validation job → ML worker /validate (sandboxed process, see 2.3)
5. Result persisted → VALIDATED or REJECTED (with every check's detail)
```

The MLflow import path is identical from step 3 onward: the artifact is pulled from MLflow's store, hashed, and copied, so serving never depends on MLflow's mutable storage.

### 2.3 Validation checks (ML worker)

| # | Check | Fails when |
|---|---|---|
| V1 | Magic / parse | `onnx.load(..., load_external_data=False)` fails, or the file is not protobuf |
| V2 | Size | Model > 100 MB, or JSON files > 1 MB |
| V3 | Checker | `onnx.checker.check_model(full_check=True)` fails |
| V4 | External data | Any initializer has `data_location == EXTERNAL` |
| V5 | Opset | Opset outside the allowed range (e.g. 13–(ORT max)) |
| V6 | Operator domains | Any node domain not in `{"", "ai.onnx", "ai.onnx.ml"}` |
| V7 | Signature | `signature.json` invalid against JSON Schema, or names, dtypes or ranks don't match the graph inputs/outputs |
| V8 | Load budget | Session creation > 10 s, or peak RSS > 400 MB (child process with rlimits) |
| V9 | Golden examples | Any output differs beyond tolerance (`abs 1e-4` for probabilities, exact for labels) |
| V10 | Latency budget | p95 on golden examples > 50 ms single-threaded |
| V11 | Checksum | Stored SHA-256 ≠ recomputed SHA-256 at validation time |

V8–V10 run in a **child process** with a CPU-time limit and memory cap. The ML worker container itself is non-root, read-only, with CPU and memory limits, so even a pathological graph cannot take down the host.

### 2.4 Load-time defence in depth (model server)

1. Downloads only via presigned URL for exactly one key.
2. Recomputes SHA-256, and **refuses to start** if it doesn't match the value passed by the orchestrator (`ARTIFACT_CHECKSUM_MISMATCH`).
3. `onnxruntime.SessionOptions`: `intra_op_num_threads=1`, `inter_op_num_threads=1`, graph optimizations enabled, no custom op libraries registered.
4. Batch size cap (64) and request body cap (256 KB) at the gateway and the server.

## 3. Authorization model (RBAC)

| Permission | Owner | Admin | ML Eng | Viewer |
|---|:-:|:-:|:-:|:-:|
| View projects, models, endpoints, metrics, drift | ✅ | ✅ | ✅ | ✅ |
| Create/edit projects, models, versions, datasets | ✅ | ✅ | ✅ | ❌ |
| Deploy / canary / promote / rollback in **staging** | ✅ | ✅ | ✅ | ❌ |
| Request production deployment | ✅ | ✅ | ✅ | ❌ |
| Approve production deployment (not own request) | ✅ | ✅ | ❌ | ❌ |
| Canary / promote / rollback in **production** | ✅ | ✅ | ❌ | ❌ |
| Set `champion` alias | ✅ | ✅ | ❌ | ❌ |
| Manage API keys | ✅ | ✅ | ❌ | ❌ |
| Manage members (non-Owner roles) | ✅ | ✅ | ❌ | ❌ |
| Grant/revoke Owner, delete org | ✅ | ❌ | ❌ | ❌ |
| Read audit log | ✅ | ✅ | ❌ | ❌ |

Implementation (M8 names: `approval:decide`, `release:manage`): a `@RequirePermission(...)` decorator with a `PermissionsGuard`, plus a role → permission map in one file (`apps/api/src/common/authz/permissions.ts`). The permission table above is **generated from that file** in CI, so docs and code cannot diverge.

## 4. Authentication details

| Concern | Decision |
|---|---|
| Password hashing | Argon2id (`argon2` npm), memory 19 MiB, t=2, p=1 (OWASP minimum) |
| Session token | 256-bit random, stored as SHA-256 hash; cookie `mo_session`, `HttpOnly; SameSite=Lax; Path=/; Secure` (Secure in non-local) |
| Session lifetime | 7 days sliding, 30 days absolute, rotated on login and privilege change |
| CSRF | Mutating requests require `X-CSRF-Token`, which must match a per-session token (returned by `/auth/me`). SameSite=Lax is a second layer |
| Login protection | 5 attempts/min per IP+email, constant-time compare, generic error message |
| API key format | `mo_<8-char prefix>_<32-byte base62 secret>`. Lookup by prefix, verify with `HMAC-SHA256(pepper, secret)` + `timingSafeEqual` |
| Why HMAC, not Argon2, for API keys | Keys are high-entropy random strings, so slow hashing adds nothing against brute force, while costing latency on every inference request. A server-side pepper means a leaked DB alone is useless |

## 5. Secrets management (zero cost)

- Local: `.env` (gitignored), generated by `scripts/init-env` with random values. `.env.example` is committed with placeholders only.
- Compose: secrets passed as environment variables, or as Docker secrets for the session pepper and DB password.
- kind (M10): Kubernetes Secrets, created from `.env` by a script, never committed.
- CI: GitHub Actions secrets (free). Tests use throwaway generated values.
- AWS (validate-only): Terraform references AWS Secrets Manager / SSM Parameter Store ARNs, with no secret values in code.

## 6. Container hardening checklist

- [ ] Multi-stage builds; final images `python:3.12-slim` / `node:24-slim` pinned by digest
- [ ] `USER 10001` (non-root), `read_only: true`, `tmpfs: /tmp`
- [ ] `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`
- [ ] CPU, memory and pids limits on every service
- [ ] Model servers on an `internal: true` network only
- [ ] Only the docker-socket-proxy mounts `/var/run/docker.sock` (read-only), and only the orchestrator can reach the proxy
- [ ] Healthchecks for every service
- [ ] Trivy scan in CI fails on CRITICAL vulnerabilities that have a fix available

## 7. Adversarial security tests (to implement in M4/M9)

| ID | Attack | Input | Expected |
|---|---|---|---|
| SEC-1 | Pickle disguised as ONNX | `.onnx` file containing a pickle payload | `REJECTED`, check V1; payload never executed (sentinel file not created) |
| SEC-2 | External data path traversal | ONNX initializer with `location=../../etc/passwd` | `REJECTED`, V4 |
| SEC-3 | Custom op domain | Node with domain `com.evil` | `REJECTED`, V6 |
| SEC-4 | Oversized artifact | 150 MB file | `413` at finalise, or `REJECTED` V2 |
| SEC-5 | Checksum tamper | Replace object in storage after validation | Model server refuses to start → `FAILED (ARTIFACT_CHECKSUM_MISMATCH)` |
| SEC-6 | Deploy unvalidated version | Direct `POST /revisions` with `PENDING_VALIDATION` id | `422 MODEL_NOT_VALIDATED`; DB trigger blocks even if the API check is bypassed |
| SEC-7 | Cross-tenant IDOR | User of org B requests org A's model id with org B's orgId and with org A's orgId | `404` both ways |
| SEC-8 | Role escalation | ML Engineer approves own production request; Admin grants Owner | `403` |
| SEC-9 | Self-approval | Admin approves an approval they requested | `403 SELF_APPROVAL` (M8: tested; the same shortcut in SQL hits the CHECK `approvals_four_eyes`, and queueing a production revision without an APPROVED row hits a trigger) |
| SEC-10 | Revoked / expired API key | Call predict with a revoked key | `401` within the key-cache TTL (≤ 30 s) |
| SEC-11 | API key of another project | Key from project X on project Y's endpoint | `404` |
| SEC-12 | CSRF | Cross-site form POST without token | `403 CSRF_TOKEN_INVALID` |
| SEC-13 | Oversized / malformed inference | 10 MB body, batch 10 000, NaN, wrong types | `413` / `400`; model server never receives it |
| SEC-14 | Log leakage | Predict with a sentinel value in the input | Sentinel absent from all service logs |
| SEC-15 | PromQL injection | `metrics?series=sum(up)` or arbitrary query | `400`, because only allow-listed series names are accepted |
| SEC-16 | Brute-force login | 20 rapid attempts | `429` after 5 |
