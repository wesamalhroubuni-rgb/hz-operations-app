import { Directory, File, Paths } from 'expo-file-system';

// Where prepared photos wait until they are uploaded: a folder in the app's document directory,
// which the system does not clear (unlike the cache, where the picker and the manipulator write).

const FOLDER = 'pending-photos';

function folder(): Directory {
  const directory = new Directory(Paths.document, FOLDER);
  if (!directory.exists) {
    directory.create({ intermediates: true });
  }
  return directory;
}

/** Moves a prepared photo into the waiting folder; returns its new URI and its size in bytes. */
export async function keepPhoto(
  sourceUri: string,
  localId: string,
): Promise<{ uri: string; sizeBytes: number }> {
  const source = new File(sourceUri);
  const destination = new File(folder(), `${localId}.jpg`);
  if (destination.exists) destination.delete();
  await source.move(destination);
  return { uri: destination.uri, sizeBytes: destination.size };
}

/** Deletes a local file; a file that is already gone is fine. */
export async function deleteLocalFile(uri: string): Promise<void> {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Nothing to do: the file is gone or was never ours.
  }
}

/** Whether a local photo still exists (a draft restored after the files were cleared). */
export function localFileExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}
