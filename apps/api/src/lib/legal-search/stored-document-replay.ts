import { Result } from "better-result";

import { sha256Hex } from "@stll/sha256/bun";

import {
  decodeSourceRawEnvelopeObjects,
  StoredRawReadError,
  type StoredRawReparseInput,
} from "@/api/lib/legal-search/ingestion-types";

/** Read only the object the envelope names; absence never triggers a publisher read. */
export const readStoredDocumentObject = async (
  stored: StoredRawReparseInput,
  part: string,
): Promise<Result<Uint8Array | null, StoredRawReadError>> => {
  const ref = decodeSourceRawEnvelopeObjects(
    new TextDecoder().decode(stored.raw),
  )[part];
  if (ref === undefined) {
    return Result.ok(null);
  }
  if (stored.readObject === undefined) {
    return Result.err(
      new StoredRawReadError({
        message: "Stored document replay requires an object reader",
        key: ref.location,
        cause: "object-reader-required",
        permanent: false,
      }),
    );
  }
  const read = await stored.readObject(ref.location);
  if (Result.isError(read)) {
    return read;
  }
  const bytes = read.value;
  if (bytes === null) {
    return Result.ok(null);
  }
  if (bytes.byteLength !== ref.byteLength || sha256Hex(bytes) !== ref.sha256) {
    return Result.err(
      new StoredRawReadError({
        message:
          "Stored document does not match its envelope digest and length",
        key: ref.location,
        cause: "object-integrity-mismatch",
        permanent: true,
      }),
    );
  }
  return Result.ok(bytes);
};
