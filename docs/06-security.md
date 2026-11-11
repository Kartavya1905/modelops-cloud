# 06 — Security Design and Model Artifact Security Strategy

> Status: **implemented through M9** (reviewed 2026-11-11). Each control lists the test that proves it; the threat model below has a status column from the M9 review.

## 1. Threat model (summary)

| Asset | Threat | Control | Status (M9 review) |
|---|---|---|---|
| Inference runtime | Malicious artifact runs code on load (pickle `__reduce__`, custom ops, external data path traversal) | ONNX-only, operator-domain allow-list, no external data, no custom op libraries, sandboxed validation | ✅ SEC-1…3 |
| Inference runtime | Resource exhaustion (huge model, decompression bomb, giant batch) | Size limits, load-time memory and time budget in validation, batch ≤ 64, CPU/memory/pids limits | ✅ SEC-4, SEC-13; pids limits on every container since M9 |
| Inference runtime | A validated model fails on real inputs (latent bug) | Canary on a share of traffic, automatic analysis and abort, fallback to stable, non-finite outputs refused | ✅ M8 (new since Phase 0) |
| Tenant data | Cross-tenant read or write (IDOR) | `org_id` on every row, membership guard, scoped queries, 404 on mismatch | ✅ SEC-7, permission matrix. **Postgres RLS: deferred** (Tier 3, see the M9 doc) |
| Accounts | Credential stuffing, session theft, CSRF | Argon2id, login rate limit, httpOnly SameSite cookies, CSRF token header, session rotation | ✅ SEC-12, SEC-16 |
| Production | One person ships to production alone, or approves their own change | Four-eyes approvals: API + CHECK constraint + trigger | ✅ SEC-8, SEC-9 (new since Phase 0) |
| API keys | Leakage from the database or logs | Only an HMAC-SHA256 of the secret is stored; secret shown once; redacted in logs; scoped, revocable, expiring | ✅ SEC-10, SEC-11 |
| Docker host | Orchestrator compromise → host takeover | Socket **proxy** exposing only container endpoints; no `privileged`, no host mounts, no host network for model servers | ✅ `pnpm check:hardening` (the proxy is the one root container, by design) |
| Kubernetes (M10) | A model server reaches the databases or other tenants' pods; the worker's credentials are abused | Per-revision NetworkPolicy (ingress only from gateway pods; egress only DNS + S3 + collector by `cidr:port`), default-deny namespace, `restricted` Pod Security, worker-only ServiceAccount with a namespaced Role (no exec, no secrets) | ✅ probed from real pods in `test:k8s`. Enforcement starts once kindnet has seen a new pod's IP (well under a second; see the M10 doc) |
| Supply chain | Vulnerable dependencies or images | Lockfiles, `pnpm audit`, `pip-audit`, Trivy image scan (CI, M9) | ✅ in CI. **M11:** actions pinned by commit SHA, every image by digest, Dependabot with a 7-day cooldown, workflows linted (actionlint), published images scanned before push and shipped with an SBOM and provenance |
| Secrets | Secrets committed to git | `.env` gitignored, `.env.example` only, gitleaks over the full history in CI (M9) | ✅. **Not yet:** a pre-commit hook (CI catches it on push) |
| Customer inputs | Sensitive inputs leaked via logs or events | Bodies never logged; input capture opt-in per endpoint; 7-day retention | ✅ SEC-14 (M9): a sentinel through every path is in no log, event or audit row |
| Audit trail | Tampering to hide actions | Append-only trigger; hash chain (M9): every entry commits to the one before it, verified in the database | ✅ edits and deletions detected even when made by the table owner. The app role *owns* the tables (migrations run as it), so the trigger, not a missing grant, is what stops the app |

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
- kind (M10): a Kubernetes Secret (`modelops-secrets`), generated by Kustomize from `infra/k8s/overlays/kind/secrets.env`, which `pnpm kind:up` writes from `.env` (gitignored, mode 600). Only the API and worker read all of it; the gateway gets three keys (`REDIS_URL`, the API-key pepper, its internal token). Model-server pods get no secret at all (a presigned URL per artifact, as on Docker).
- CI: GitHub Actions secrets (free). Tests use throwaway generated values.
- AWS (validate-only, M11): tasks read SSM SecureString parameters under `/modelops/<env>/<component>/`, created out of band, so no secret value is in the code or the Terraform state; each execution role can read only its own component's path. The RDS master password is generated and kept by RDS in Secrets Manager. CI would push images through GitHub OIDC (no stored AWS keys).

## 6. Container hardening checklist

Checked on the **running** containers by `pnpm check:hardening` (`scripts/hardening.mjs`, `docker inspect`), locally and in CI after the e2e tests (M9). Before M9: 19 gaps; after: 0, plus two documented exceptions.

- [x] Multi-stage builds for the gateway, ml-worker and model server (MLflow is a single `pip install` stage on a slim base). Base images pinned by digest since M11
- [x] Non-root, `read_only: true`, `tmpfs` where needed: every container (the one-shot `storage-init` too, as 10001), including Postgres (999), Redis (999) and SeaweedFS (1000) since M9. **Exception:** the Docker socket proxy runs as root with a writable root filesystem (it must read the root-owned socket and renders its config at start-up); it has no capabilities, a read-only socket mount and an API allow-list
- [x] `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]` on every container
- [x] CPU, memory and pids limits on every service and every model server
- [x] Model servers on an `internal: true` network only
- [x] Only the docker-socket-proxy mounts `/var/run/docker.sock` (read-only), and only the orchestrator can reach the proxy
- [x] Healthchecks for every long-running service
- [x] Trivy scan in CI fails on CRITICAL vulnerabilities that have a fix available (our four images; HIGH ones are listed). M10 adds the API and web images (kind job)
- [x] **Exceptions (M10):** the OTel Collector and Tempo images are distroless, so they cannot run a Docker healthcheck; their health shows in the tracing tests and `pnpm kind:smoke`

**Kubernetes (M10, `infra/k8s`):** every pod runs non-root with a read-only root filesystem, no capabilities, no privilege escalation, RuntimeDefault seccomp and requests/limits; both namespaces enforce the `restricted` Pod Security Standard; only the worker mounts a service-account token. **Local-only exception:** the kind kubelet's read-only port (10255) is enabled so the compose Prometheus can read container CPU/memory without cluster credentials. It is unauthenticated, has no host port mapping and is reachable only from the compose networks on this machine. It must never be enabled on a shared cluster.

## 7. Adversarial security tests (all implemented by M9; the M9 doc maps each to its test)

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
