-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('BINARY_CLASSIFICATION');

-- CreateEnum
CREATE TYPE "ModelFramework" AS ENUM ('SKLEARN_ONNX', 'PYTORCH_ONNX');

-- CreateEnum
CREATE TYPE "ModelVersionStatus" AS ENUM ('PENDING_VALIDATION', 'VALIDATING', 'VALIDATED', 'REJECTED');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "mlflow_experiment_id" TEXT;

-- CreateTable
CREATE TABLE "dataset_versions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "row_count" INTEGER,
    "uri" TEXT NOT NULL,
    "generator_params" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registered_models" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "task_type" "TaskType" NOT NULL DEFAULT 'BINARY_CLASSIFICATION',
    "mlflow_name" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registered_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_versions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "framework" "ModelFramework" NOT NULL,
    "status" "ModelVersionStatus" NOT NULL DEFAULT 'PENDING_VALIDATION',
    "mlflow_run_id" TEXT NOT NULL,
    "mlflow_version" TEXT,
    "source_uri" TEXT NOT NULL,
    "reported_sha256" CHAR(64),
    "signature" JSONB NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "training_dataset_version_id" UUID,
    "parent_version_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dataset_versions_org_id_created_at_idx" ON "dataset_versions"("org_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "dataset_versions_project_id_sha256_key" ON "dataset_versions"("project_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "registered_models_mlflow_name_key" ON "registered_models"("mlflow_name");

-- CreateIndex
CREATE INDEX "registered_models_org_id_created_at_idx" ON "registered_models"("org_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "registered_models_project_id_slug_key" ON "registered_models"("project_id", "slug");

-- CreateIndex
CREATE INDEX "model_versions_org_id_created_at_idx" ON "model_versions"("org_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "model_versions_model_id_version_key" ON "model_versions"("model_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "model_versions_model_id_mlflow_run_id_key" ON "model_versions"("model_id", "mlflow_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_mlflow_experiment_id_key" ON "projects"("mlflow_experiment_id");

-- AddForeignKey
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registered_models" ADD CONSTRAINT "registered_models_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registered_models" ADD CONSTRAINT "registered_models_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registered_models" ADD CONSTRAINT "registered_models_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "registered_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_training_dataset_version_id_fkey" FOREIGN KEY ("training_dataset_version_id") REFERENCES "dataset_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_parent_version_id_fkey" FOREIGN KEY ("parent_version_id") REFERENCES "model_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

