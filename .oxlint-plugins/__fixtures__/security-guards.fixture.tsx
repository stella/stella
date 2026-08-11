// Passive regression fixture covering every security-guards rule.

// oxlint-disable-next-line security-guards/no-unscoped-user-query -- fixture: user import lacks organization membership scope
import { user } from "@/api/db/auth-schema";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
// oxlint-disable-next-line security-guards/require-secure-document-response -- fixture: handlers must not assemble the document security policy manually
import { RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS } from "@/api/lib/security-headers";

declare const file: { name: string };
declare const item: { url: string };
declare const sanitizedName: string;
declare const safeUrl: string;
declare const bytes: Uint8Array;

// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: raw upload name reaches persisted filename
export const rawFile = { fileName: file.name };
export const safeFile = { fileName: sanitizedName };

export const UnsafeLink = () => (
  // oxlint-disable-next-line security-guards/no-unsanitized-href -- fixture: external member value may contain a script URL
  <a href={item.url}>Open</a>
);
export const SafeLink = () => <a href={safeUrl}>Open</a>;

export const unsafeDocumentResponse =
  // oxlint-disable-next-line security-guards/require-secure-document-response -- fixture: direct attachment Response bypasses the typed security boundary
  new Response(bytes, {
    headers: { "Content-Disposition": 'attachment; filename="unsafe.pdf"' },
  });
export const safeDocumentResponse = secureDocumentResponse({
  body: bytes,
  contentType: "application/pdf",
  disposition: "attachment",
  fileName: sanitizeFilename("safe.pdf"),
});
export const emptyResponse = new Response(null, { status: 404 });

void user;
void RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS;
