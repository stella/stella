import { Result, TaggedError } from "better-result";
import { CryptoDigestAlgorithm, digest } from "expo-crypto";

import type { Fetch } from "@/connection/http";
import { fetchWithTimeout } from "@/connection/http";
import { hexOf } from "@/state/hex";

/** A file the app holds could not be read, so it cannot be uploaded. */
export class LocalFileError extends TaggedError("LocalFileError")<{
  message: string;
  cause?: unknown;
}> {}

/** A picked file's size and digest, which an upload is signed for. */
export type LocalFileFacts = {
  readonly size: number;
  readonly sha256Hex: string;
};

/**
 * Reads a file the app holds (a picked document, copied into its cache) for
 * its size and SHA-256, as the server checks an upload against both.
 */
export const readLocalFile = async (
  fetch: Fetch,
  uri: string,
): Promise<Result<LocalFileFacts, LocalFileError>> =>
  await Result.tryPromise({
    try: async () => {
      const bytes = new Uint8Array(
        await (await fetchWithTimeout(fetch, uri)).arrayBuffer(),
      );
      const hash = new Uint8Array(
        await digest(CryptoDigestAlgorithm.SHA256, bytes),
      );
      return { size: bytes.byteLength, sha256Hex: hexOf(hash) };
    },
    catch: (cause) =>
      new LocalFileError({
        message: `The file at ${uri} could not be read`,
        cause,
      }),
  });
