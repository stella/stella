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
import { isStampableDocx, stripStamp } from "@/api/lib/docx-stamp";

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

type StoredDocumentBytesOptions = {
  buffer: ArrayBuffer | Uint8Array;
  mimeType: string;
};

/**
 * The bytes to store for a document file. Non-DOCX input and DOCX too large to
 * have been stamped on the way out are returned untouched, as is a DOCX that
 * carries no reference, so an ordinary upload keeps its exact bytes and hash.
 */
export const storedDocumentBytes = async ({
  buffer,
  mimeType,
}: StoredDocumentBytesOptions): Promise<StoredDocumentBytes> => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  // The same predicate gates injection, so the two sides cannot disagree about
  // which files can be carrying a reference.
  if (!isStampableDocx(mimeType, bytes.byteLength)) {
    return { bytes, strippedArchive: null };
  }

  const strippedArchive = await stripStamp(bytes);
  return strippedArchive === null
    ? { bytes, strippedArchive: null }
    : { bytes: new Uint8Array(strippedArchive), strippedArchive };
};
