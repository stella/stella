import { Result } from "better-result";

import { STRUCTURED_DOCUMENT_FORMATS } from "@stll/api-contract/structured-document-formats";

import { readOfdDocument } from "@/api/lib/files/ofd-document";
import { readUyapDocument } from "@/api/lib/files/uyap-document";
import {
  documentPackageError,
  openXmlDocumentPackage,
} from "@/api/lib/files/xml-document-package";

const readers = {
  ofd: readOfdDocument,
  uyap: readUyapDocument,
} satisfies Record<
  (typeof STRUCTURED_DOCUMENT_FORMATS)[number]["kind"],
  typeof readOfdDocument
>;

export const extractStructuredDocument = async ({
  fileBytes,
  mimeType,
  maxChars,
}: {
  fileBytes: Uint8Array;
  mimeType: string;
  maxChars: number;
}) => {
  const format = STRUCTURED_DOCUMENT_FORMATS.find(
    (entry) => entry.mimeType === mimeType,
  );
  if (!format) {
    return Result.err(documentPackageError("Unknown document format"));
  }
  const archive = await openXmlDocumentPackage(fileBytes);
  if (archive.isErr()) {
    return Result.err(archive.error);
  }
  return readers[format.kind](archive.value, maxChars);
};
