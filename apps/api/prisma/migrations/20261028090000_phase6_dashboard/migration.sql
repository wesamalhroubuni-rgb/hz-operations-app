-- Phase 6 (web dashboard, ADR-0009): each user's language, used by the apps and by the
-- server-rendered notification text. The organization time zone lives in Organization.settings
-- (timeZone), so it needs no column.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en';
