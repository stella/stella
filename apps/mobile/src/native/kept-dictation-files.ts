import { Result, TaggedError } from "better-result";
import { Directory, File, Paths } from "expo-file-system";
import * as v from "valibot";

import type { BeforeSessionEnd } from "@/connection/session-end";
import { keptDictationFolder } from "@/native/dictation-device";
import { keptDictationSchema, keptFor } from "@/state/dictation-kept";
import type { KeptDictation } from "@/state/dictation-kept";

/** The phone could not write, read or remove a kept dictation's files. */
class KeptDictationFileError extends TaggedError("KeptDictationFileError")<{
  message: string;
  cause?: unknown;
}> {}

/** Each kept dictation is a folder: its recordings and this description. */
const DESCRIPTION = "dictation.json";
/** A description being written, until it replaces the last one whole. */
const NEXT_DESCRIPTION = "dictation.next.json";

/**
 * Where kept dictations wait: on iOS a folder of the app's own, left out of
 * backups and readable once the phone has been unlocked after it started,
 * so a retry while locked can read it; elsewhere the app's documents.
 */
const keptRoot = (): Directory => {
  const native = keptDictationFolder();
  const root =
    native === null
      ? new Directory(Paths.document, "dictation-kept")
      : new Directory(native);
  root.create({ idempotent: true, intermediates: true });
  return root;
};

const folderOf = (id: string): Directory => new Directory(keptRoot(), id);

const failure =
  (message: string) =>
  (cause: unknown): KeptDictationFileError =>
    new KeptDictationFileError({ message, cause });

/**
 * Every kept dictation this build can read. One whose description it
 * cannot read (written by a newer build, or unreadable) stays on the phone
 * untouched and does not keep the others from being read. A description
 * whose replacement was cut short reads from the one being written.
 */
export const listKeptDictations = async (): Promise<
  Result<KeptDictation[], KeptDictationFileError>
> =>
  await Result.tryPromise({
    try: async () => {
      const read = await Promise.all(
        keptRoot()
          .list()
          .map(async (entry) => {
            const description =
              entry instanceof Directory ? descriptionIn(entry) : null;
            if (description === null) {
              return [];
            }
            const text = await Result.tryPromise(
              async () => await description.text(),
            );
            const parsed = v.safeParse(
              v.pipe(v.string(), v.parseJson(), keptDictationSchema),
              text.unwrapOr(""),
            );
            return parsed.success ? [parsed.output] : [];
          }),
      );
      return read.flat();
    },
    catch: failure("The kept dictations could not be listed"),
  });

/** The folder's description: the last one written whole, else one cut short. */
const descriptionIn = (folder: Directory): File | null => {
  for (const name of [DESCRIPTION, NEXT_DESCRIPTION]) {
    const file = new File(folder, name);
    if (file.exists) {
      return file;
    }
  }
  return null;
};

/**
 * Writes a description beside the last one, then puts it in its place, so
 * an interrupted write never leaves a folder without one.
 */
const writeDescription = (folder: Directory, kept: KeptDictation) => {
  const next = new File(folder, NEXT_DESCRIPTION);
  next.writeSync(JSON.stringify(kept));
  next.moveSync(new File(folder, DESCRIPTION), { overwrite: true });
};

/**
 * Keeps a dictation: copies each of its recordings (`file` is its name in
 * the dictation's folder, `uri` where the recorder left it) into the folder
 * and writes its description, then deletes the originals. Whether it was
 * kept; when not, the half-made folder goes and the recordings are where
 * they were.
 */
export const keepDictation = (
  kept: KeptDictation,
  recordings: readonly { readonly file: string; readonly uri: string }[],
): boolean => {
  const written = Result.try({
    try: () => {
      const folder = folderOf(kept.id);
      folder.create({ idempotent: true });
      for (const { file, uri } of recordings) {
        new File(uri).copySync(new File(folder, file));
      }
      writeDescription(folder, kept);
    },
    catch: failure(`The dictation ${kept.id} could not be kept`),
  }).isOk();
  if (!written) {
    forgetKeptDictation(kept.id);
    return false;
  }
  for (const { uri } of recordings) {
    deleteFile(uri);
  }
  return true;
};

/** Deletes a recording the recorder left, now that it is kept. Whether it is gone. */
const deleteFile = (uri: string): boolean =>
  Result.try(() => {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  }).isOk();

/** Writes a kept dictation's description again, as a retry moved it on. Whether it was written. */
export const updateKeptDictation = (kept: KeptDictation): boolean =>
  Result.try({
    try: () => {
      writeDescription(folderOf(kept.id), kept);
    },
    catch: failure(`The dictation ${kept.id} could not be updated`),
  }).isOk();

/** Where one of a kept dictation's recordings is, for its upload. */
export const keptRecordingUri = (id: string, file: string): string =>
  new File(folderOf(id), file).uri;

/** Deletes one recording once its text is kept instead. Whether it is gone. */
export const removeKeptRecording = (id: string, file: string): boolean =>
  Result.try({
    try: () => {
      const recording = new File(folderOf(id), file);
      if (recording.exists) {
        recording.delete();
      }
    },
    catch: failure(`A recording of the dictation ${id} could not be removed`),
  }).isOk();

/** Deletes a kept dictation, its recordings and text with it. Whether it is gone. */
export const forgetKeptDictation = (id: string): boolean =>
  Result.try({
    try: () => {
      const folder = folderOf(id);
      if (folder.exists) {
        folder.delete();
      }
    },
    catch: failure(`The dictation ${id} could not be removed`),
  }).isOk();

/**
 * Deletes the ending account's kept dictations from the phone, recordings
 * and recovered texts alike; another account's stay.
 */
export const forgetKeptDictations: BeforeSessionEnd = async (
  _reason,
  session,
) => {
  const listed = await listKeptDictations();
  if (listed.isErr()) {
    return;
  }
  for (const kept of listed.value) {
    if (keptFor(kept, session)) {
      forgetKeptDictation(kept.id);
    }
  }
};
