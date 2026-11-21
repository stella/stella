/**
 * The transcript or its cleaned-up text as a Word document, built here with
 * the same stella styles the API files in a matter, then saved where the
 * user picks. The document library is loaded only when a document is saved,
 * so no other window pays for it.
 */

import { invoke } from "@tauri-apps/api/core";
import { Result, TaggedError } from "better-result";

/** The header that carries the suggested file name, percent-encoded. */
const TRANSCRIBE_DOCX_FILE_NAME_HEADER = "x-stella-file-name";

export type TranscriptDocx =
  | {
      kind: "raw";
      title: string;
      paragraphs: readonly { startMs: number; text: string }[];
    }
  | {
      kind: "cleaned";
      markdown: string;
      instructions: readonly string[];
      /** The label above the instructions, in the member's language. */
      instructionsLabel: string;
    };

export class TranscriptDocxError extends TaggedError("TranscriptDocxError")<{
  message: string;
  cause: unknown;
}> {}

/** The document's bytes, in stella's house style. */
export const buildTranscriptDocx = async (
  document: TranscriptDocx,
): Promise<Result<Uint8Array, TranscriptDocxError>> => {
  const loaded = await Result.tryPromise({
    try: async () => await import("@stll/docx-authoring/transcript"),
    catch: (cause) =>
      new TranscriptDocxError({
        message: "The Word document writer could not be loaded",
        cause,
      }),
  });
  if (Result.isError(loaded)) {
    return loaded;
  }
  const { cleanedTranscriptDocx, transcriptDocx } = loaded.value;
  const built =
    document.kind === "raw"
      ? await transcriptDocx(document)
      : await cleanedTranscriptDocx(document);
  return Result.map(
    Result.mapError(
      built,
      (cause) => new TranscriptDocxError({ message: cause.message, cause }),
    ),
    (bytes) => new Uint8Array(bytes),
  );
};

/**
 * Builds the document and saves it where the user picks, suggesting
 * `fileName`; `false` when they cancel.
 */
export const saveTranscriptDocx = async (
  document: TranscriptDocx,
  fileName: string,
): Promise<Result<boolean, TranscriptDocxError>> => {
  const built = await buildTranscriptDocx(document);
  if (Result.isError(built)) {
    return built;
  }
  return await Result.tryPromise({
    try: async () =>
      await invoke<boolean>("transcribe_save_docx", built.value, {
        headers: {
          [TRANSCRIBE_DOCX_FILE_NAME_HEADER]: encodeURIComponent(fileName),
        },
      }),
    catch: (cause) =>
      new TranscriptDocxError({
        message: "The Word document could not be saved",
        cause,
      }),
  });
};
