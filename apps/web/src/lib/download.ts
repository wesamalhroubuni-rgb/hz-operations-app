import { CSV_BOM } from '@ops/shared';

/**
 * Saves text the API returned as a file, in the browser. Used by the CSV export buttons:
 * the export is fetched through `apiClient.exports.*` (so it carries the session, renews it on
 * a 401, and its errors are readable), then handed to the browser as a download.
 *
 * `Response.text()` drops the UTF-8 byte order mark the API sends; `withBom` puts it back so
 * Excel reads Turkish and Arabic correctly.
 */
export function saveTextFile(
  text: string,
  fileName: string,
  { mimeType = 'text/csv;charset=utf-8', withBom = true } = {},
): void {
  const body = withBom && !text.startsWith(CSV_BOM) ? `${CSV_BOM}${text}` : text;
  const url = URL.createObjectURL(new Blob([body], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFileName(fileName);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the URL is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name without path separators or control characters. */
export function safeFileName(name: string): string {
  let cleaned = '';
  for (const character of name) {
    const code = character.charCodeAt(0);
    cleaned += code < 0x20 || code === 0x7f || '\\/:*?"<>|'.includes(character) ? '-' : character;
  }
  cleaned = cleaned.trim();
  return cleaned === '' ? 'export.csv' : cleaned.slice(0, 120);
}
