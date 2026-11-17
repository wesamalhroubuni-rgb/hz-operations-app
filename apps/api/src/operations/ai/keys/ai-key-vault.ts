import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiKeyProvider } from '@ops/shared';
import { SecretBox, type SealedSecret } from '../../../platform/crypto';

/** Label of the key derived from `AI_KEYS_ENCRYPTION_SECRET` (separates it from other uses). */
const LABEL = 'hz.ai-provider-key.v1';

/** The stored, encrypted form of a key (the columns of `AiProviderKey`). */
export interface StoredAiKey {
  keyVersion: number;
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
}

/**
 * Encrypts and decrypts organizations' AI provider keys (ADR-0012) with
 * `AI_KEYS_ENCRYPTION_SECRET`. The organization id and the provider are the associated data, so
 * a row moved to another organization or provider does not decrypt. Without the secret, nothing
 * can be stored or read (`available` is false).
 */
@Injectable()
export class AiKeyVault {
  private readonly logger = new Logger('AiKeyVault');
  private readonly box: SecretBox | null;
  /** Keys already reported as unreadable (once per process, not on every AI call). */
  private readonly reported = new Set<string>();

  constructor(config: ConfigService) {
    const secret = config.get<string>('AI_KEYS_ENCRYPTION_SECRET');
    this.box =
      typeof secret === 'string' && secret.length >= 32 ? new SecretBox(secret, LABEL) : null;
  }

  get available(): boolean {
    return this.box !== null;
  }

  seal(organizationId: string, provider: AiKeyProvider, apiKey: string): StoredAiKey {
    if (!this.box) {
      throw new Error('AI_KEYS_ENCRYPTION_SECRET is not set');
    }
    const sealed = this.box.seal(apiKey, associatedData(organizationId, provider));
    return {
      keyVersion: sealed.version,
      ciphertext: Uint8Array.from(sealed.ciphertext),
      iv: Uint8Array.from(sealed.iv),
      authTag: Uint8Array.from(sealed.authTag),
    };
  }

  /** The key, or null when it cannot be read (no secret, another secret, tampered row). */
  open(organizationId: string, provider: AiKeyProvider, stored: StoredAiKey): string | null {
    if (!this.box) {
      return null;
    }
    try {
      return this.box.open(
        {
          version: stored.keyVersion as SealedSecret['version'],
          ciphertext: stored.ciphertext,
          iv: stored.iv,
          authTag: stored.authTag,
        },
        associatedData(organizationId, provider),
      );
    } catch {
      const id = associatedData(organizationId, provider);
      if (this.reported.has(id)) return null;
      this.reported.add(id);
      // Ids only: never the row's bytes.
      this.logger.error(
        `ai key unreadable organizationId=${organizationId} provider=${provider} ` +
          '(was AI_KEYS_ENCRYPTION_SECRET changed? an admin must save the key again)',
      );
      return null;
    }
  }
}

function associatedData(organizationId: string, provider: AiKeyProvider): string {
  return `${organizationId}:${provider}`;
}
