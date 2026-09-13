/**
 * One rule for every path that puts document bytes into object storage:
 * stored DOCX bytes never carry a stella document reference.
 *
 * The reference is minted per download, from the version being downloaded
 * (`handlers/files/get.ts`). Storing bytes that still carry one freezes version
 * N-1's verification code into version N, so every later plain download hands
 * out a stale reference and a returning file is misfiled. A stamped download
 * re-uploaded as a new document would likewise keep resolving to the document
 * it came from.
 *
 * `docx-strip-ownership-policy.ts` names the modules that must call this and
 * the ones that provably need not.
 */
import { stripStamp } from "@/api/lib/docx-stamp";
import { hasZipMagic } from "@/api/lib/file-scan/zip";
import { LIMITS } from "@/api/lib/limits";

type StoredDocumentBytes = {
  /** The bytes to store. Identical to the input unless a reference was removed. */
  bytes: Uint8Array;
  /**
   * The rewritten archive, or null when the input carried no reference and is
   * stored byte for byte. Non-null means the size and hash recorded for the
   * version must be derived from these bytes, not from what the client sent.
   */
  strippedArchive: ArrayBuffer | null;
};

/**
 * The bytes to store for a document file. Archive identity comes from the
 * bytes, never the caller-controlled MIME type. Non-ZIP input and archives too
 * large to have been stamped on the way out are returned untouched;
 * `stripStamp` then confirms the package is a DOCX before changing it.
 */
export const storedDocumentBytes = async (
  buffer: ArrayBuffer | Uint8Array,
): Promise<StoredDocumentBytes> => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (bytes.byteLength > LIMITS.docxStampMaxBytes || !hasZipMagic(bytes)) {
    return { bytes, strippedArchive: null };
  }

  const strippedArchive = await stripStamp(bytes);
  return strippedArchive === null
    ? { bytes, strippedArchive: null }
    : { bytes: new Uint8Array(strippedArchive), strippedArchive };
};
