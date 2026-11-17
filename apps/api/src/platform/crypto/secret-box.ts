import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encryption of small secrets at rest (reusable platform component, ADR-0012): AES-256-GCM with
 * a random 12-byte nonce, the key derived from a server secret with SHA-256 (the secret is at
 * least 32 random characters, so no stretching is needed). The caller passes associated data
 * that binds the ciphertext to where it is stored (for example the owner's id and the kind of
 * secret): a ciphertext copied to another place fails to decrypt.
 *
 * Never logs. Errors carry no plaintext, key or ciphertext.
 */
export interface SealedSecret {
  /** Format version; 1 = AES-256-GCM, key = SHA-256(label + secret). */
  version: 1;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

export class SecretBox {
  private readonly key: Buffer;

  /**
   * @param secret the server secret (at least 32 characters).
   * @param label separates keys derived from the same secret for different purposes.
   */
  constructor(secret: string, label: string) {
    if (secret.length < 32) {
      throw new SecretBoxError('The encryption secret must be at least 32 characters');
    }
    this.key = createHash('sha256').update(`${label}\u0000${secret}`, 'utf8').digest();
  }

  seal(plaintext: string, associatedData: string): SealedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { version: 1, ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  /** Throws `SecretBoxError` for a wrong secret, tampered data or other associated data. */
  open(sealed: SealedSecret, associatedData: string): string {
    if (sealed.version !== 1) {
      throw new SecretBoxError(`Unknown secret format version ${String(sealed.version)}`);
    }
    if (sealed.iv.byteLength !== IV_BYTES || sealed.authTag.byteLength !== TAG_BYTES) {
      throw new SecretBoxError('The sealed secret is malformed');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(sealed.iv), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(Buffer.from(sealed.authTag));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new SecretBoxError('The sealed secret could not be decrypted');
    }
  }
}
