-- CreateEnum
CREATE TYPE "ModelVersionSource" AS ENUM ('MLFLOW_RUN', 'UPLOAD');

-- CreateEnum
CREATE TYPE "ValidationResult" AS ENUM ('PASSED', 'FAILED', 'ERROR');

-- AlterTable
ALTER TABLE "model_versions" ADD COLUMN     "artifact_sha256" CHAR(64),
ADD COLUMN     "golden_sha256" CHAR(64),
ADD COLUMN     "signature_sha256" CHAR(64),
ADD COLUMN     "size_bytes" INTEGER,
ADD COLUMN     "source" "ModelVersionSource" NOT NULL DEFAULT 'MLFLOW_RUN',
ADD COLUMN     "validated_at" TIMESTAMPTZ(3),
ADD COLUMN     "validation_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "validation_lease_until" TIMESTAMPTZ(3),
ALTER COLUMN "mlflow_run_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "validation_reports" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "result" "ValidationResult" NOT NULL,
    "checks" JSONB NOT NULL,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "validator_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "validation_reports_version_id_created_at_idx" ON "validation_reports"("version_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "model_versions_status_validation_lease_until_idx" ON "model_versions"("status", "validation_lease_until");

-- AddForeignKey
ALTER TABLE "validation_reports" ADD CONSTRAINT "validation_reports_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_reports" ADD CONSTRAINT "validation_reports_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

