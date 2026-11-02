import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedPrompt, PromptLoader } from './ai-types';

/** Prompt ids: lower-case words joined by hyphens (`smart-capture-extract`). */
const PROMPT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;
const HEADER_KEYS = ['id', 'version', 'purpose'] as const;

/** The file name of a prompt version. */
export function promptFileName(id: string, version: number): string {
  return `${id}.v${version}.md`;
}

/** Placeholders of a prompt body, each once, in order of first use. */
export function placeholdersOf(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((match) => match[1]!))];
}

/**
 * Parses a prompt file (see `LoadedPrompt` in ./ai-types.ts). Line endings are normalised to
 * `\n` first, so the SHA-256 is the same on a Windows checkout and in a Linux container.
 * Throws with the file name and the reason when the file is not a valid prompt.
 */
export function parsePromptFile(
  fileName: string,
  raw: string,
  expected: { id: string; version: number },
): LoadedPrompt {
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, '\n');
  const fail = (reason: string): never => {
    throw new Error(`Prompt file ${fileName}: ${reason}`);
  };
  if (!text.startsWith('---\n')) {
    fail('must start with a "---" header line');
  }
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) {
    fail('the header is not closed by a "---" line');
  }
  const header: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const match = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!match) {
      fail(`header line "${line}" is not "key: value"`);
    }
    const [, key, value] = match!;
    if (!(HEADER_KEYS as readonly string[]).includes(key!)) {
      fail(`unknown header key "${key}"`);
    }
    if (key! in header) {
      fail(`header key "${key}" appears twice`);
    }
    header[key!] = value!.trim();
  }
  for (const key of HEADER_KEYS) {
    if (!header[key]) {
      fail(`header key "${key}" is missing`);
    }
  }
  const version = Number(header.version);
  if (!Number.isInteger(version) || version < 1 || String(version) !== header.version) {
    fail(`version "${header.version}" is not a positive integer`);
  }
  if (header.id !== expected.id || version !== expected.version) {
    fail(
      `the header says ${promptFileName(header.id!, version)}, ` +
        `the file is ${promptFileName(expected.id, expected.version)}`,
    );
  }
  const body = text
    .slice(end + 5)
    .replace(/^\n+/, '')
    .trimEnd();
  if (body === '') {
    fail('the prompt text is empty');
  }
  const placeholders = new Set(placeholdersOf(body));
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');

  return {
    id: expected.id,
    version,
    purpose: header.purpose!,
    body,
    sha256,
    render(variables) {
      const names = Object.keys(variables);
      const unused = names.filter((name) => !placeholders.has(name));
      if (unused.length > 0) {
        throw new Error(`Prompt ${fileName}: values not used by the prompt: ${unused.join(', ')}`);
      }
      const missing = [...placeholders].filter(
        (name) => !Object.prototype.hasOwnProperty.call(variables, name),
      );
      if (missing.length > 0) {
        throw new Error(`Prompt ${fileName}: no value for ${missing.join(', ')}`);
      }
      // A function replacer: `$&` and friends in a value stay literal.
      return body.replace(PLACEHOLDER, (_match, name: string) => variables[name]!);
    },
  };
}

/**
 * Loads `<id>.v<version>.md` from the first of the registered folders that has it, parses it
 * once and keeps it (prompt files never change while the process runs). Throws for an invalid
 * id or version, a missing file, or an invalid file: those are programming errors.
 */
export class FilePromptLoader implements PromptLoader {
  private readonly cache = new Map<string, LoadedPrompt>();

  constructor(private readonly directories: readonly string[]) {}

  load(id: string, version: number): LoadedPrompt {
    if (!PROMPT_ID.test(id)) {
      throw new Error(`Invalid prompt id "${id}"`);
    }
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`Invalid prompt version ${version} for "${id}"`);
    }
    const fileName = promptFileName(id, version);
    const cached = this.cache.get(fileName);
    if (cached) {
      return cached;
    }
    const path = this.directories
      .map((directory) => join(directory, fileName))
      .find((candidate) => existsSync(candidate));
    if (!path) {
      throw new Error(`Prompt ${fileName} was not found in the prompt folders`);
    }
    const prompt = parsePromptFile(fileName, readFileSync(path, 'utf8'), { id, version });
    this.cache.set(fileName, prompt);
    return prompt;
  }
}
