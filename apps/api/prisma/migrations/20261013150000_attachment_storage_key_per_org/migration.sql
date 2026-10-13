-- A storage key only has to be unique inside its organization. A global unique index would let
-- one tenant learn, from a conflict, that another tenant uses the same key.

-- DropIndex
DROP INDEX "Attachment_storageKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_organizationId_storageKey_key" ON "Attachment"("organizationId", "storageKey");
