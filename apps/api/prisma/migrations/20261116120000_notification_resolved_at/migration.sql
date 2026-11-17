-- Notifications that are no longer needed are resolved (hidden, kept as history).

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "resolvedAt" TIMESTAMPTZ(3);
