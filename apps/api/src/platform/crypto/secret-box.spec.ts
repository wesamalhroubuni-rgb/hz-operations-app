import { SecretBox, SecretBoxError } from './secret-box';

const SECRET = 'k'.repeat(16) + 'Q7v!x2#Lp9@zR4mW';
const KEY = 'sk-ant-api03-EXAMPLEEXAMPLEEXAMPLE-abcd';

describe('SecretBox', () => {
  const box = new SecretBox(SECRET, 'ai-provider-key');

  it('opens what it sealed, with the same associated data', () => {
    const sealed = box.seal(KEY, 'org-1:anthropic');
    expect(box.open(sealed, 'org-1:anthropic')).toBe(KEY);
  });

  it('never stores the plaintext and uses a fresh nonce each time', () => {
    const first = box.seal(KEY, 'org-1:anthropic');
    const second = box.seal(KEY, 'org-1:anthropic');
    expect(Buffer.from(first.ciphertext).toString('utf8')).not.toContain('sk-ant');
    expect(Buffer.from(first.iv).equals(Buffer.from(second.iv))).toBe(false);
    expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false);
  });

  it('refuses other associated data (a row copied to another organization or provider)', () => {
    const sealed = box.seal(KEY, 'org-1:anthropic');
    expect(() => box.open(sealed, 'org-2:anthropic')).toThrow(SecretBoxError);
    expect(() => box.open(sealed, 'org-1:openai')).toThrow(SecretBoxError);
  });

  it('refuses a tampered ciphertext or tag', () => {
    const sealed = box.seal(KEY, 'a');
    const ciphertext = Buffer.from(sealed.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    expect(() => box.open({ ...sealed, ciphertext }, 'a')).toThrow(SecretBoxError);
    const authTag = Buffer.from(sealed.authTag);
    authTag[0] = (authTag[0] ?? 0) ^ 1;
    expect(() => box.open({ ...sealed, authTag }, 'a')).toThrow(SecretBoxError);
  });

  it('refuses another secret or another label', () => {
    const sealed = box.seal(KEY, 'a');
    expect(() => new SecretBox(`${SECRET}x`, 'ai-provider-key').open(sealed, 'a')).toThrow(
      SecretBoxError,
    );
    expect(() => new SecretBox(SECRET, 'other').open(sealed, 'a')).toThrow(SecretBoxError);
  });

  it('refuses a short secret, and its errors never contain the key', () => {
    expect(() => new SecretBox('short', 'x')).toThrow(SecretBoxError);
    const sealed = box.seal(KEY, 'a');
    try {
      box.open(sealed, 'b');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(KEY);
    }
  });
});
