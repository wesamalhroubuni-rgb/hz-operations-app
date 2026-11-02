-- Phase 7 (ADR-0010, ADR-0011): smart capture, daily summaries, anomaly flags, AI traces.
-- Generated with prisma migrate diff against a throwaway shadow database; the WorkLogSource
-- change was edited by hand into a rename.

-- CreateEnum
CREATE TYPE "SmartCaptureInputKind" AS ENUM ('voice', 'photo', 'text');

-- CreateEnum
CREATE TYPE "SmartCaptureStatus" AS ENUM ('awaiting_upload', 'pending', 'processing', 'proposed', 'failed', 'confirmed', 'discarded');

-- CreateEnum
CREATE TYPE "AnomalyKind" AS ENUM ('no_activity_site', 'slow_task', 'repeated_rejections', 'far_location');

-- CreateEnum
CREATE TYPE "AnomalySeverity" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "SummaryNarrativeSource" AS ENUM ('ai', 'template');

-- CreateEnum
CREATE TYPE "AiTraceStatus" AS ENUM ('ok', 'invalid_output', 'failed', 'timeout', 'limited');

-- CreateEnum
CREATE TYPE "AiDecision" AS ENUM ('confirmed', 'discarded');

-- AlterEnum
-- Renamed in place (not recreated) so any existing row keeps its value: `ai` becomes `ai_assisted`.
ALTER TYPE "WorkLogSource" RENAME VALUE 'ai' TO 'ai_assisted';

-- CreateTable
CREATE TABLE "SmartCapture" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "inputKind" "SmartCaptureInputKind" NOT NULL,
    "status" "SmartCaptureStatus" NOT NULL,
    "failureReason" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "inputStorageKey" TEXT,
    "inputMimeType" TEXT,
    "inputSizeBytes" INTEGER,
    "inputDurationMs" INTEGER,
    "inputPurgedAt" TIMESTAMPTZ(3),
    "transcript" TEXT,
    "detectedLanguage" TEXT,
    "proposal" JSONB,
    "confidence" JSONB,
    "traceIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "processingUntil" TIMESTAMPTZ(3),
    "processedAt" TIMESTAMPTZ(3),
    "workLogId" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SmartCapture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailySummary" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "timeZone" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "stats" JSONB NOT NULL,
    "anomalies" JSONB NOT NULL DEFAULT '[]',
    "narrative" TEXT NOT NULL,
    "narrativeSource" "SummaryNarrativeSource" NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "traceIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailySummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnomalyFlag" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "kind" "AnomalyKind" NOT NULL,
    "severity" "AnomalySeverity" NOT NULL,
    "siteId" UUID,
    "teamId" UUID,
    "userId" UUID,
    "taskId" UUID,
    "workLogId" UUID,
    "logTypeId" UUID,
    "params" JSONB NOT NULL DEFAULT '{}',
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnomalyFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiTrace" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptId" TEXT,
    "promptVersion" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "inputRefs" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "status" "AiTraceStatus" NOT NULL,
    "errorCode" TEXT,
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "audioSeconds" DOUBLE PRECISION,
    "costEstimateUsd" DECIMAL(12,6),
    "requestedById" UUID,
    "decision" "AiDecision",
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "correlationId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmartCapture_organizationId_workerId_createdAt_idx" ON "SmartCapture"("organizationId", "workerId", "createdAt");

-- CreateIndex
CREATE INDEX "SmartCapture_status_createdAt_idx" ON "SmartCapture"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SmartCapture_organizationId_clientId_key" ON "SmartCapture"("organizationId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "SmartCapture_organizationId_inputStorageKey_key" ON "SmartCapture"("organizationId", "inputStorageKey");

-- CreateIndex
CREATE UNIQUE INDEX "SmartCapture_workLogId_key" ON "SmartCapture"("workLogId");

-- CreateIndex
CREATE INDEX "DailySummary_organizationId_day_idx" ON "DailySummary"("organizationId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "DailySummary_organizationId_recipientId_day_key" ON "DailySummary"("organizationId", "recipientId", "day");

-- CreateIndex
CREATE INDEX "AnomalyFlag_organizationId_day_idx" ON "AnomalyFlag"("organizationId", "day");

-- CreateIndex
CREATE INDEX "AnomalyFlag_organizationId_kind_day_idx" ON "AnomalyFlag"("organizationId", "kind", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AnomalyFlag_organizationId_fingerprint_key" ON "AnomalyFlag"("organizationId", "fingerprint");

-- CreateIndex
CREATE INDEX "AiTrace_organizationId_createdAt_idx" ON "AiTrace"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiTrace_organizationId_feature_createdAt_idx" ON "AiTrace"("organizationId", "feature", "createdAt");

-- CreateIndex
CREATE INDEX "AiTrace_requestedById_createdAt_idx" ON "AiTrace"("requestedById", "createdAt");

-- AddForeignKey
ALTER TABLE "SmartCapture" ADD CONSTRAINT "SmartCapture_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartCapture" ADD CONSTRAINT "SmartCapture_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartCapture" ADD CONSTRAINT "SmartCapture_workLogId_fkey" FOREIGN KEY ("workLogId") REFERENCES "WorkLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySummary" ADD CONSTRAINT "DailySummary_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySummary" ADD CONSTRAINT "DailySummary_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnomalyFlag" ADD CONSTRAINT "AnomalyFlag_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

