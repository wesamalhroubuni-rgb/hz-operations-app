import type { UntrustedDataBlock } from './ai-types';

/** Block names are code-chosen identifiers (`transcript`, `task_titles`). */
const BLOCK_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Escapes text so it cannot close a data block or open another: `&`, `<` and `>` become
 * entities (the ampersand too, so an escaped entity in the input stays distinguishable).
 */
export function escapeUntrustedText(content: string): string {
  return content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The inverse of {@link escapeUntrustedText} (used by the fake provider only). */
export function unescapeUntrustedText(content: string): string {
  return content.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Untrusted data (a transcript, a worker's text, names read from the database) wrapped as
 * `<name>` ... `</name>`, with the content escaped so it can never end the block early or
 * pretend to be another one. Every system prompt says block contents are data, not instructions.
 * Throws for a name that is not a plain identifier (a programming error).
 */
export const untrustedDataBlock: UntrustedDataBlock = (name, content) => {
  if (!BLOCK_NAME.test(name)) {
    throw new Error(`Invalid data block name "${name}"`);
  }
  return `<${name}>\n${escapeUntrustedText(content)}\n</${name}>`;
};
