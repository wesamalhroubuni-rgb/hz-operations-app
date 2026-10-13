/** The fields of the one log line written per finished request. */
export interface RequestLogEntry {
  msg: 'request';
  method: string;
  /** Path only. The query string is dropped because its values can carry personal data. */
  path: string;
  status: number;
  durationMs: number;
  correlationId: string;
  actorId: string | null;
}

/** Paths that are polled or serve static documentation; logged at debug level only. */
export const DEFAULT_QUIET_PATHS: readonly string[] = [
  '/health',
  '/docs',
  '/docs-json',
  '/docs-yaml',
];

/** The path of a request URL without its query string or fragment. */
export function pathOf(url: string | undefined): string {
  if (!url) {
    return '/';
  }
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end) || '/';
}

/** True when `path` is one of the quiet paths or lies below one of them. */
export function isQuietPath(path: string, quietPaths: readonly string[]): boolean {
  return quietPaths.some((quiet) => path === quiet || path.startsWith(`${quiet}/`));
}

/** The log line: one single-line JSON object, with a fixed key order. */
export function formatRequestLog(entry: Omit<RequestLogEntry, 'msg'>): string {
  const line: RequestLogEntry = {
    msg: 'request',
    method: entry.method,
    path: entry.path,
    status: entry.status,
    durationMs: entry.durationMs,
    correlationId: entry.correlationId,
    actorId: entry.actorId,
  };
  return JSON.stringify(line);
}
