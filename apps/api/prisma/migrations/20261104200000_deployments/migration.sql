-- CreateEnum
CREATE TYPE "EndpointEnvironment" AS ENUM ('STAGING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "RevisionState" AS ENUM ('REQUESTED', 'AWAITING_APPROVAL', 'QUEUED', 'PROVISIONING', 'LOADING', 'VERIFYING', 'READY', 'DEGRADED', 'DRAINING', 'RETIRED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "endpoints" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "environment" "EndpointEnvironment" NOT NULL DEFAULT 'STAGING',
    "stable_revision_id" UUID,
    "rate_limit_rps" INTEGER NOT NULL DEFAULT 50,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_revisions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "model_version_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "state" "RevisionState" NOT NULL DEFAULT 'REQUESTED',
    "state_version" INTEGER NOT NULL DEFAULT 0,
    "state_deadline_at" TIMESTAMPTZ(3),
    "resources" JSONB NOT NULL DEFAULT '{"cpus": 0.5, "memoryMb": 512}',
    "failure_code" TEXT,
    "failure_detail" TEXT,
    "runtime_ref" TEXT,
    "ready_at" TIMESTAMPTZ(3),
    "drain_until" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "restart_count" INTEGER NOT NULL DEFAULT 0,
    "restart_window_start" TIMESTAMPTZ(3),
    "previous_revision_id" UUID,
    "requested_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deployment_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_events" (
    "id" BIGSERIAL NOT NULL,
    "org_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "from_state" "RevisionState",
    "to_state" "RevisionState" NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "org_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("org_id","key")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secret_hash" BYTEA NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['predict']::TEXT[],
    "expires_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "endpoints_stable_revision_id_key" ON "endpoints"("stable_revision_id");

-- CreateIndex
CREATE INDEX "endpoints_org_id_created_at_idx" ON "endpoints"("org_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "endpoints_project_id_slug_key" ON "endpoints"("project_id", "slug");

-- CreateIndex
CREATE INDEX "deployment_revisions_state_state_deadline_at_idx" ON "deployment_revisions"("state", "state_deadline_at");

-- CreateIndex
CREATE INDEX "deployment_revisions_org_id_created_at_idx" ON "deployment_revisions"("org_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "deployment_revisions_endpoint_id_revision_number_key" ON "deployment_revisions"("endpoint_id", "revision_number");

-- CreateIndex
CREATE INDEX "deployment_events_revision_id_id_idx" ON "deployment_events"("revision_id", "id");

-- CreateIndex
CREATE INDEX "outbox_messages_dispatched_at_created_at_idx" ON "outbox_messages"("dispatched_at", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE INDEX "api_keys_project_id_created_at_idx" ON "api_keys"("project_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_stable_revision_id_fkey" FOREIGN KEY ("stable_revision_id") REFERENCES "deployment_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_revisions" ADD CONSTRAINT "deployment_revisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_revisions" ADD CONSTRAINT "deployment_revisions_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_revisions" ADD CONSTRAINT "deployment_revisions_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_revisions" ADD CONSTRAINT "deployment_revisions_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "deployment_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

