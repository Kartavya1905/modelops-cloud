-- CreateEnum
CREATE TYPE "RolloutStrategy" AS ENUM ('IMMEDIATE', 'CANARY');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CanaryVerdict" AS ENUM ('PASS', 'FAIL', 'INCONCLUSIVE');

-- AlterTable
ALTER TABLE "deployment_revisions" ADD COLUMN     "canary_weight" INTEGER,
ADD COLUMN     "rollback_of_id" UUID,
ADD COLUMN     "strategy" "RolloutStrategy" NOT NULL DEFAULT 'IMMEDIATE';

-- AlterTable
ALTER TABLE "endpoints" ADD COLUMN     "canary_revision_id" UUID,
ADD COLUMN     "canary_started_at" TIMESTAMPTZ(3),
ADD COLUMN     "canary_weight" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "canary_policy" JSONB NOT NULL DEFAULT '{"minDurationSeconds": 300, "minRequests": 200, "maxErrorRateIncrease": 0.01, "maxLatencyRatio": 1.25}';

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" UUID,
    "reason" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canary_checks" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "verdict" "CanaryVerdict" NOT NULL,
    "metrics" JSONB NOT NULL,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "policy" JSONB NOT NULL,
    "aborted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canary_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approvals_revision_id_key" ON "approvals"("revision_id");

-- CreateIndex
CREATE INDEX "approvals_org_id_status_created_at_idx" ON "approvals"("org_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "canary_checks_revision_id_created_at_idx" ON "canary_checks"("revision_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "endpoints_canary_revision_id_key" ON "endpoints"("canary_revision_id");

-- AddForeignKey
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_canary_revision_id_fkey" FOREIGN KEY ("canary_revision_id") REFERENCES "deployment_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "deployment_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canary_checks" ADD CONSTRAINT "canary_checks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canary_checks" ADD CONSTRAINT "canary_checks_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canary_checks" ADD CONSTRAINT "canary_checks_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "deployment_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

