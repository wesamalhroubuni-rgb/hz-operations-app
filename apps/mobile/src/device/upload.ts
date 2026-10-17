import type { UploadPut, UploadPutResult } from '@ops/shared';
import { File, UploadType } from 'expo-file-system';

/**
 * PUTs a local file to a signed storage URL with exactly the headers the API returned, reporting
 * progress. Uses expo-file-system's native upload (it streams the file and reports bytes sent);
 * if that is unavailable it falls back to `fetch` with the file as a blob, which works but cannot
 * report progress (the bar then jumps from 0 to 100%). Never throws; never logs the URL, whose
 * query string is a credential.
 */
export function putFileFromUri(uri: string): UploadPut {
  return async (target, onProgress): Promise<UploadPutResult> => {
    try {
      const file = new File(uri);
      if (typeof file.upload === 'function') {
        const result = await file.upload(target.url, {
          httpMethod: target.method,
          uploadType: UploadType.BINARY_CONTENT,
          headers: target.headers,
          onProgress: ({ bytesSent, totalBytes }) => {
            if (totalBytes > 0) onProgress(bytesSent / totalBytes);
          },
        });
        return result.status >= 200 && result.status < 300
          ? { ok: true }
          : { ok: false, status: result.status, message: `Storage answered ${result.status}` };
      }
      return await putWithFetch(uri, target, onProgress);
    } catch (error) {
      return {
        ok: false,
        status: 0,
        message: error instanceof Error ? error.message : 'Upload failed',
      };
    }
  };
}

async function putWithFetch(
  uri: string,
  target: Parameters<UploadPut>[0],
  onProgress: (fraction: number) => void,
): Promise<UploadPutResult> {
  const body = await (await fetch(uri)).blob();
  onProgress(0);
  const response = await fetch(target.url, {
    method: target.method,
    headers: target.headers,
    body,
  });
  if (!response.ok) {
    return { ok: false, status: response.status, message: `Storage answered ${response.status}` };
  }
  onProgress(1);
  return { ok: true };
}
