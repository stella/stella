import { Result, TaggedError } from "better-result";
import { requireOptionalNativeModule } from "expo";

/** A document's file on this phone, for as long as its viewer is open. */
export type OpenedFile = {
  readonly uri: string;
  readonly size: number;
};

type DocumentFilesModule = {
  readonly download: (url: string, fileName: string) => Promise<OpenedFile>;
  readonly readBase64: (
    uri: string,
    offset: number,
    length: number,
  ) => Promise<string>;
  /** Settles when the person closes the preview. */
  readonly preview: (uri: string) => Promise<void>;
  readonly discard: (uri: string) => void;
};

// Absent on Android, the web and a client built before the viewer.
const files = requireOptionalNativeModule<DocumentFilesModule>("DocumentFiles");

export class DocumentDownloadError extends TaggedError(
  "DocumentDownloadError",
)<{
  message: string;
  /** No connection, rather than a refusal or a broken file. */
  offline: boolean;
  cause?: unknown;
}> {}

const codeOf = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code)
    : undefined;

/** Whether this build can open files natively. */
export const canOpenFiles = (): boolean => files !== null;

/** Downloads a document's file from its short-lived link into protected caches. */
export const downloadDocument = async (
  url: string,
  fileName: string,
): Promise<Result<OpenedFile, DocumentDownloadError>> =>
  files === null
    ? Result.err(
        new DocumentDownloadError({
          message: "This build cannot open documents",
          offline: false,
        }),
      )
    : await Result.tryPromise({
        try: async () => await files.download(url, fileName),
        catch: (cause) =>
          new DocumentDownloadError({
            message: "The document could not be downloaded",
            offline: codeOf(cause) === "ERR_DOCUMENT_OFFLINE",
            cause,
          }),
      });

/** `length` bytes of an opened file from `offset`, in base64. */
export const readOpenedFile = async (
  file: OpenedFile,
  offset: number,
  length: number,
): Promise<string> =>
  files === null ? "" : await files.readBase64(file.uri, offset, length);

/** Shows an opened file in Quick Look; settles when it closes. */
export const previewOpenedFile = async (file: OpenedFile): Promise<void> => {
  await files?.preview(file.uri);
};

/** Removes an opened file from the phone. */
export const discardOpenedFile = (file: OpenedFile): void => {
  files?.discard(file.uri);
};
