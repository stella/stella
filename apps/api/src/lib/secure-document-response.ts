import { contentDisposition } from "@/api/lib/content-disposition";
import type { SanitizedFileName } from "@/api/lib/sanitize-filename";
import { RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS } from "@/api/lib/security-headers";

const CONTENT_LENGTH_RE = /^\d+$/u;

export const parseContentLengthHeader = (
  value: string | null,
): number | undefined => {
  if (value === null || !CONTENT_LENGTH_RE.test(value)) {
    return undefined;
  }

  const contentLength = Number(value);
  return Number.isSafeInteger(contentLength) ? contentLength : undefined;
};

export type SecureDocumentResponseOptions = {
  body: Exclude<ConstructorParameters<typeof Response>[0], undefined>;
  contentType: string;
  disposition: "attachment" | "inline";
  fileName: SanitizedFileName;
  additionalHeaders?: ConstructorParameters<typeof Headers>[0];
  contentLength?: number;
};

export const secureDocumentResponse = ({
  body,
  contentType,
  disposition,
  fileName,
  additionalHeaders,
  contentLength,
}: SecureDocumentResponseOptions): Response => {
  const headers = new Headers(additionalHeaders);
  for (const [key, value] of Object.entries(
    RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
  )) {
    headers.set(key, value);
  }
  headers.set("Content-Disposition", contentDisposition(fileName, disposition));
  headers.set("Content-Type", contentType);
  if (contentLength !== undefined) {
    headers.set("Content-Length", String(contentLength));
  } else {
    headers.delete("Content-Length");
  }

  return new Response(body, { headers });
};
