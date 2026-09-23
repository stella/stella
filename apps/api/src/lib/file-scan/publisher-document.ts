import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { mintScannedFile } from "@/api/lib/file-scan/scanned-file";

type PublisherDocumentInput = {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  /** The case-law adapter that fetched the bytes from its publisher. */
  adapterKey: string;
};

/**
 * A decision file a case-law adapter downloaded from its publisher. These
 * bytes are not user uploads: each adapter fetches from its own allowlisted
 * origin, and the ingestion scripts are bundled to single files that cannot
 * carry the scanner's native addon. The `scanned-file-boundary` lint rule
 * restricts this import to `handlers/case-law/ingestion/adapters/`.
 */
export const publisherDocument = ({
  bytes,
  mimeType,
  fileName,
  adapterKey,
}: PublisherDocumentInput): ScannedFile =>
  mintScannedFile({
    bytes: new Uint8Array(bytes).buffer,
    fileName,
    mimeType,
    source: { type: "publisher", adapterKey },
  });
