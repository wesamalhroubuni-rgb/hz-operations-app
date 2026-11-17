-- ADR-0012: an organization's own AI provider keys, stored encrypted (AES-256-GCM).

-- CreateEnum
CREATE TYPE "AiKeyProvider" AS ENUM ('anthropic', 'openai');

-- CreateTable
CREATE TABLE "AiProviderKey" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "provider" "AiKeyProvider" NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "hint" TEXT NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiProviderKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiProviderKey_organizationId_provider_key" ON "AiProviderKey"("organizationId", "provider");

-- AddForeignKey
ALTER TABLE "AiProviderKey" ADD CONSTRAINT "AiProviderKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
