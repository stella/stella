import type { ContentPart } from "@tanstack/ai";
import JSZip from "jszip";

import { toDataUrl } from "@/api/lib/data-url";

// Attachment parts as the web composer sends them
// (`buildChatRequestMessage`): an `image` part for an image file, a
// `document` part for any other, each carrying the file as a data URL. The
// send path uploads them and hydrates them into what the model reads.

/** A 1×1 PNG. */
const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (character) => character.codePointAt(0) ?? 0,
);

/** A one-page PDF with one line of text. */
const PDF_TEXT = [
  "%PDF-1.4",
  "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
  "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
  "4 0 obj << /Length 44 >> stream",
  "BT /F1 12 Tf 20 100 Td (The brief.) Tj ET",
  "endstream endobj",
  "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
  "trailer << /Root 1 0 R >>",
  "%%EOF",
].join("\n");

const docxBytes = async (): Promise<Uint8Array> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>The draft.</w:t></w:r></w:p></w:body></w:document>`,
  );
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
  );
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
};

const encoder = new TextEncoder();

/** The bytes of an attachment of `mimeType`. */
const bytesOf = async (mimeType: string): Promise<Uint8Array> => {
  if (mimeType.startsWith("image/")) {
    return PNG_BYTES;
  }
  if (mimeType === "application/pdf") {
    return encoder.encode(PDF_TEXT);
  }
  if (mimeType.startsWith("text/")) {
    return encoder.encode("party,role\nAcme,buyer\n");
  }
  return await docxBytes();
};

/** The part the composer sends for a file named `fileName` of
 *  `mimeType`. */
export const composerAttachmentPart = async ({
  fileName,
  mimeType,
}: {
  fileName: string;
  mimeType: string;
}): Promise<ContentPart> => {
  const source = {
    type: "url" as const,
    value: toDataUrl(await bytesOf(mimeType), mimeType),
    mimeType,
  };
  const metadata = { filename: fileName };
  return mimeType.startsWith("image/")
    ? { type: "image", source, metadata }
    : { type: "document", source, metadata };
};
