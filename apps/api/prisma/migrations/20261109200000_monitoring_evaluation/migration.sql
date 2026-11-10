-- CreateEnum
CREATE TYPE "EvaluationStatus" AS ENUM ('COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "api_keys" ALTER COLUMN "scopes" SET DEFAULT ARRAY['predict', 'feedback']::TEXT[];

-- AlterTable
ALTER TABLE "dataset_versions" ADD COLUMN     "columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "stored_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "endpoints" ADD COLUMN     "capture_inputs" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "evaluation_policy" JSONB NOT NULL DEFAULT '{"minRocAuc": 0.7, "maxRocAucDrop": 0.01, "maxLogLossIncrease": 0.02}';

-- AlterTable
ALTER TABLE "registered_models" ADD COLUMN     "champion_evaluation_id" UUID,
ADD COLUMN     "champion_set_at" TIMESTAMPTZ(3),
ADD COLUMN     "champion_version_id" UUID;

-- CreateTable
CREATE TABLE "prediction_records" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "model_version_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "prediction_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prediction_feedback" (
    "prediction_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prediction_feedback_pkey" PRIMARY KEY ("prediction_id")
);

-- CreateTable
CREATE TABLE "drift_reports" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "model_version_id" UUID NOT NULL,
    "reference_dataset_version_id" UUID NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "window_end" TIMESTAMPTZ(3) NOT NULL,
    "sample_count" INTEGER NOT NULL,
    "dataset_drift" BOOLEAN NOT NULL,
    "drift_share" DOUBLE PRECISION NOT NULL,
    "feature_scores" JSONB NOT NULL,
    "evidently_version" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drift_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_reports" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "candidate_version_id" UUID NOT NULL,
    "baseline_version_id" UUID,
    "dataset_version_id" UUID NOT NULL,
    "status" "EvaluationStatus" NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "policy" JSONB NOT NULL,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "failure_detail" TEXT,
    "requested_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prediction_records_endpoint_id_created_at_idx" ON "prediction_records"("endpoint_id", "created_at");

-- CreateIndex
CREATE INDEX "prediction_records_created_at_idx" ON "prediction_records"("created_at");

-- CreateIndex
CREATE INDEX "drift_reports_endpoint_id_created_at_idx" ON "drift_reports"("endpoint_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "evaluation_reports_model_id_created_at_idx" ON "evaluation_reports"("model_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "registered_models_champion_version_id_key" ON "registered_models"("champion_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "registered_models_champion_evaluation_id_key" ON "registered_models"("champion_evaluation_id");

-- AddForeignKey
ALTER TABLE "registered_models" ADD CONSTRAINT "registered_models_champion_version_id_fkey" FOREIGN KEY ("champion_version_id") REFERENCES "model_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registered_models" ADD CONSTRAINT "registered_models_champion_evaluation_id_fkey" FOREIGN KEY ("champion_evaluation_id") REFERENCES "evaluation_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prediction_records" ADD CONSTRAINT "prediction_records_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prediction_feedback" ADD CONSTRAINT "prediction_feedback_prediction_id_fkey" FOREIGN KEY ("prediction_id") REFERENCES "prediction_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drift_reports" ADD CONSTRAINT "drift_reports_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drift_reports" ADD CONSTRAINT "drift_reports_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drift_reports" ADD CONSTRAINT "drift_reports_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drift_reports" ADD CONSTRAINT "drift_reports_reference_dataset_version_id_fkey" FOREIGN KEY ("reference_dataset_version_id") REFERENCES "dataset_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "registered_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_candidate_version_id_fkey" FOREIGN KEY ("candidate_version_id") REFERENCES "model_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_baseline_version_id_fkey" FOREIGN KEY ("baseline_version_id") REFERENCES "model_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_dataset_version_id_fkey" FOREIGN KEY ("dataset_version_id") REFERENCES "dataset_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

