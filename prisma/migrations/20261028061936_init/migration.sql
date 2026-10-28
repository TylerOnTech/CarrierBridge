-- CreateEnum
CREATE TYPE "PullStatus" AS ENUM ('pending', 'running', 'succeeded', 'partially_succeeded', 'failed');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "pulls" (
    "id" UUID NOT NULL,
    "status" "PullStatus" NOT NULL DEFAULT 'pending',
    "idempotency_key" VARCHAR(255),
    "request_fingerprint" CHAR(64) NOT NULL,
    "correlation_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "pulls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_tasks" (
    "id" UUID NOT NULL,
    "pull_id" UUID NOT NULL,
    "carrier_id" VARCHAR(64) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "encrypted_credentials" TEXT,
    "error_category" VARCHAR(64),
    "error_code" VARCHAR(128),
    "error_message" TEXT,
    "error_retryable" BOOLEAN,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "attempt_history" JSONB NOT NULL DEFAULT '[]',
    "policy_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pull_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL,
    "pull_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "carrier_id" VARCHAR(64) NOT NULL,
    "external_policy_id" VARCHAR(128) NOT NULL,
    "schema_version" VARCHAR(16) NOT NULL,
    "policy_type" VARCHAR(32) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "effective_date" DATE,
    "expiration_date" DATE,
    "document" JSONB NOT NULL,
    "retrieved_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pulls_idempotency_key_key" ON "pulls"("idempotency_key");

-- CreateIndex
CREATE INDEX "pulls_status_created_at_idx" ON "pulls"("status", "created_at");

-- CreateIndex
CREATE INDEX "pull_tasks_status_carrier_id_available_at_idx" ON "pull_tasks"("status", "carrier_id", "available_at");

-- CreateIndex
CREATE INDEX "pull_tasks_status_lease_expires_at_idx" ON "pull_tasks"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "pull_tasks_pull_id_carrier_id_key" ON "pull_tasks"("pull_id", "carrier_id");

-- CreateIndex
CREATE INDEX "policies_pull_id_carrier_id_external_policy_id_idx" ON "policies"("pull_id", "carrier_id", "external_policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "policies_task_id_external_policy_id_key" ON "policies"("task_id", "external_policy_id");

-- AddForeignKey
ALTER TABLE "pull_tasks" ADD CONSTRAINT "pull_tasks_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "pulls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "pulls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "pull_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
