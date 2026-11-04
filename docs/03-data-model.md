# 03 — Data Model (Entity-Relationship Diagram)

> Status: **Design (Phase 0)**. The Prisma schema in `apps/api/prisma/schema.prisma` (M2+) is the executable version of this document. MLflow keeps its own tables in a separate database (`mlflow`), which the platform never writes to directly.

## 1. ERD

```mermaid
erDiagram
  USER ||--o{ MEMBERSHIP : has
  USER ||--o{ SESSION : has
  ORGANIZATION ||--o{ MEMBERSHIP : has
  ORGANIZATION ||--o{ INVITATION : issues
  ORGANIZATION ||--o{ PROJECT : owns
  ORGANIZATION ||--o{ AUDIT_EVENT : records
  PROJECT ||--o{ API_KEY : has
  PROJECT ||--o{ DATASET_VERSION : has
  PROJECT ||--o{ REGISTERED_MODEL : has
  PROJECT ||--o{ ENDPOINT : has
  REGISTERED_MODEL ||--o{ MODEL_VERSION : has
  DATASET_VERSION ||--o{ MODEL_VERSION : "trained on"
  MODEL_VERSION |o--o{ MODEL_VERSION : "parent of"
  MODEL_VERSION ||--o{ VALIDATION_REPORT : has
  MODEL_VERSION ||--o{ EVALUATION_REPORT : "candidate in"
  ENDPOINT ||--o{ DEPLOYMENT_REVISION : has
  MODEL_VERSION ||--o{ DEPLOYMENT_REVISION : "deployed as"
  DEPLOYMENT_REVISION ||--o{ DEPLOYMENT_EVENT : emits
  DEPLOYMENT_REVISION ||--o| APPROVAL : requires
  ENDPOINT ||--o{ DRIFT_REPORT : has
  ENDPOINT ||--o{ PREDICTION_RECORD : logs
  PREDICTION_RECORD ||--o| PREDICTION_FEEDBACK : receives

  USER {
    uuid id PK
    citext email UK
    text password_hash "argon2id"
    text name
    timestamptz created_at
  }
  SESSION {
    uuid id PK
    uuid user_id FK
    bytea token_hash "sha256 of opaque token"
    timestamptz expires_at
    timestamptz revoked_at
    text ip_hash
    timestamptz created_at
  }
  ORGANIZATION {
    uuid id PK
    text name
    text slug UK
    jsonb limits "max cpu, memory, revisions"
    timestamptz created_at
  }
  MEMBERSHIP {
    uuid id PK
    uuid org_id FK
    uuid user_id FK
    enum role "OWNER ADMIN ML_ENGINEER VIEWER"
    timestamptz created_at
  }
  INVITATION {
    uuid id PK
    uuid org_id FK
    citext email
    enum role
    bytea token_hash
    timestamptz expires_at
    timestamptz accepted_at
  }
  PROJECT {
    uuid id PK
    uuid org_id FK
    text slug "unique per org"
    text name
    text mlflow_experiment_id
    jsonb promotion_policy
    uuid created_by FK
    timestamptz created_at
  }
  API_KEY {
    uuid id PK
    uuid org_id FK
    uuid project_id FK
    text name
    text prefix UK "public lookup id"
    bytea secret_hash "HMAC-SHA256 with server pepper"
    text_array scopes "predict feedback"
    timestamptz expires_at
    timestamptz last_used_at
    timestamptz revoked_at
    uuid created_by FK
  }
  DATASET_VERSION {
    uuid id PK
    uuid org_id FK
    uuid project_id FK
    text name
    int version
    text uri "s3://datasets/..."
    text sha256
    int row_count
    jsonb schema
    jsonb generator_params "seed, drift params"
    timestamptz created_at
  }
  REGISTERED_MODEL {
    uuid id PK
    uuid org_id FK
    uuid project_id FK
    text name "unique per project"
    text mlflow_name
    enum task_type "BINARY_CLASSIFICATION ..."
    timestamptz created_at
  }
  MODEL_VERSION {
    uuid id PK
    uuid org_id FK
    uuid model_id FK
    int version "unique per model"
    enum framework "SKLEARN_ONNX PYTORCH_ONNX"
    text mlflow_run_id
    text mlflow_version
    text artifact_uri "content-addressed"
    char64 artifact_sha256
    bigint size_bytes
    jsonb signature
    uuid training_dataset_version_id FK
    uuid parent_version_id FK
    enum status "PENDING_VALIDATION VALIDATING VALIDATED REJECTED"
    text_array aliases "champion challenger"
    uuid created_by FK
    timestamptz created_at
  }
  VALIDATION_REPORT {
    uuid id PK
    uuid model_version_id FK
    enum result "PASSED FAILED ERROR"
    jsonb checks "per-check name, passed, detail"
    int opset
    text_array operators
    int load_ms
    int peak_rss_mb
    float golden_p50_ms
    text validator_version
    timestamptz created_at
  }
  EVALUATION_REPORT {
    uuid id PK
    uuid org_id FK
    uuid candidate_version_id FK
    uuid baseline_version_id FK
    uuid dataset_version_id FK
    jsonb metrics "candidate, baseline, deltas"
    jsonb policy_snapshot
    boolean passed
    timestamptz created_at
  }
  ENDPOINT {
    uuid id PK
    uuid org_id FK
    uuid project_id FK
    text slug "unique per project"
    enum environment "STAGING PRODUCTION"
    uuid stable_revision_id FK
    uuid canary_revision_id FK
    int canary_weight "0-50"
    boolean capture_inputs "opt-in"
    int rate_limit_rps
    int row_version "optimistic lock"
    timestamptz created_at
  }
  DEPLOYMENT_REVISION {
    uuid id PK
    uuid org_id FK
    uuid endpoint_id FK
    uuid model_version_id FK
    int revision_number "unique per endpoint"
    enum state "see state machine"
    int state_version "CAS counter"
    jsonb resources "cpu, memory_mb"
    int attempt
    text failure_code
    text failure_detail
    text runtime_ref "container or pod name"
    text internal_url
    timestamptz state_deadline_at
    timestamptz ready_at
    timestamptz retired_at
    uuid previous_revision_id FK
    uuid requested_by FK
    timestamptz created_at
  }
  DEPLOYMENT_EVENT {
    bigint id PK
    uuid revision_id FK
    text from_state
    text to_state
    text message
    jsonb metadata
    timestamptz created_at
  }
  APPROVAL {
    uuid id PK
    uuid org_id FK
    uuid revision_id FK
    uuid requested_by FK
    uuid decided_by FK
    enum status "PENDING APPROVED REJECTED EXPIRED"
    text reason
    timestamptz decided_at
  }
  DRIFT_REPORT {
    uuid id PK
    uuid org_id FK
    uuid endpoint_id FK
    uuid reference_dataset_version_id FK
    timestamptz window_start
    timestamptz window_end
    int sample_count
    boolean dataset_drift
    float drift_share
    jsonb feature_scores "feature, method, score, drifted"
    text report_uri
    timestamptz created_at
  }
  PREDICTION_RECORD {
    uuid id PK "predictionId"
    uuid org_id FK
    uuid endpoint_id FK
    uuid revision_id FK
    uuid model_version_id FK
    jsonb output_summary "class, score - no raw inputs"
    timestamptz created_at
  }
  PREDICTION_FEEDBACK {
    uuid prediction_id PK
    text label
    timestamptz received_at
  }
  AUDIT_EVENT {
    bigint id PK
    uuid org_id FK
    enum actor_type "USER API_KEY SYSTEM"
    uuid actor_id
    text action "deployment.requested"
    text target_type
    uuid target_id
    jsonb metadata "never request bodies"
    text request_id
    bytea prev_hash
    bytea hash
    timestamptz created_at
  }
```

Two infrastructure tables are not drawn above to keep the diagram readable:

| Table | Columns | Purpose |
|---|---|---|
| `outbox_messages` | `id`, `type`, `aggregate_type`, `aggregate_id`, `payload jsonb`, `created_at`, `dispatched_at`, `attempts`, `last_error` | Durable hand-off from a DB transaction to BullMQ |
| `idempotency_keys` | `org_id`, `key`, `request_hash`, `status_code`, `response_body jsonb`, `created_at`, `expires_at` (PK `org_id, key`) | Replays the stored response for a retried `POST` |

## 2. Invariants (enforced by the database, not just code)

| Invariant | Enforcement |
|---|---|
| One membership per user per org | `UNIQUE(org_id, user_id)` |
| Slugs unique within their parent | `UNIQUE(org_id, slug)` on projects; `UNIQUE(project_id, slug)` on endpoints |
| Model versions are numbered without gaps per model | `UNIQUE(model_id, version)`; number assigned in a transaction with `SELECT … FOR UPDATE` on the parent model |
| At most **one in-progress** (not yet `READY`) revision per endpoint, which stops two concurrent deploys racing | Partial unique index: `UNIQUE(endpoint_id) WHERE state IN ('REQUESTED','AWAITING_APPROVAL','QUEUED','PROVISIONING','LOADING','VERIFYING')` |
| Revisions can only reference a validated model version | API check + worker re-check + trigger that rejects insert when `model_versions.status <> 'VALIDATED'` |
| Canary weight in range | `CHECK (canary_weight BETWEEN 0 AND 50)` |
| `canary_weight > 0` only if a canary revision is set | `CHECK (canary_weight = 0 OR canary_revision_id IS NOT NULL)` |
| Audit log is append-only | `BEFORE UPDATE OR DELETE` trigger raising an exception; app DB role has no `UPDATE/DELETE` grant on `audit_events` |
| Idempotency keys unique per tenant | `PRIMARY KEY (org_id, key)` |
| Artifacts are immutable | `artifact_sha256` is never updated (trigger); storage keys are content-addressed `sha256/<hash>/model.onnx` |

## 3. Tenancy

- Every tenant-owned table carries `org_id`, **denormalised** even where it could be derived through a join. This makes every query filterable by org with a single index and enables Postgres Row-Level Security in M9 (Tier 3).
- Composite indexes start with `org_id`, e.g. `(org_id, project_id, created_at DESC)`.
- Cross-tenant lookups return "not found", never "forbidden", so ids cannot be probed.

## 4. Data retention

| Data | Retention (default) | Reason |
|---|---|---|
| Prediction records | 7 days | Needed only to join with late feedback labels |
| Captured inputs (S3 JSONL) | 7 days | Drift windows; privacy |
| Deployment events | Forever | Debugging and history (small) |
| Audit events | Forever | Accountability |
| Idempotency keys | 24 hours | Retry window |
| Sessions | 7 days sliding, 30 days absolute | Security |

A scheduled worker job (`retention`) enforces these limits.

## 5. Storage layout (S3-compatible)

```text
mlflow-artifacts/              ← owned by MLflow
model-artifacts/sha256/<hash>/model.onnx
model-artifacts/sha256/<hash>/signature.json
model-artifacts/sha256/<hash>/golden_examples.json
datasets/<org>/<project>/<name>/v<version>/data.parquet
drift-captures/<org>/<endpoint>/<yyyy-mm-dd>/<batch-id>.jsonl.gz
reports/<org>/drift/<report-id>.html|json
uploads-staging/<org>/<upload-id>/...   ← 24 h lifecycle; never served
```
