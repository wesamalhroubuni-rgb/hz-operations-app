-- Phase 5: offline mode and sync (ADR-0008).
-- Row versions for optimistic concurrency, offline-submission facts on work logs, attachment
-- client ids, audit metadata, and the platform idempotency table. Generated with
-- `prisma migrate diff` from the previous migrations to schema.prisma.

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "clientId" UUID;

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "metadata" JSONB;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "WorkLog" ADD COLUMN     "clockSkewSeconds" INTEGER,
ADD COLUMN     "declaredAttachmentClientIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "deviceCreatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "submittedOffline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "key" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER,
    "responseBody" JSONB,
    "lockedUntil" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_organizationId_userId_key_key" ON "IdempotencyRecord"("organizationId", "userId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_organizationId_clientId_key" ON "Attachment"("organizationId", "clientId");
