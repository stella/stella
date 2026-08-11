// Passive regression fixture covering every security-guards rule.

// oxlint-disable-next-line security-guards/no-unscoped-user-query -- fixture: user import lacks organization membership scope
import { user } from "@/api/db/auth-schema";
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

// oxlint-disable-next-line security-guards/require-raw-document-security-headers -- fixture: privileged bytes omit the shared response policy
export const unsafeDocumentResponse = new Response(bytes, {
  headers: { "Content-Disposition": 'attachment; filename="unsafe.pdf"' },
});
export const safeDocumentResponse = new Response(bytes, {
  headers: {
    ...RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
    "Content-Disposition": 'attachment; filename="safe.pdf"',
  },
});
// oxlint-disable-next-line security-guards/require-raw-document-security-headers -- fixture: a later protected override defeats the shared response policy
export const overriddenDocumentResponse = new Response(bytes, {
  headers: {
    ...RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
    "Cache-Control": "public",
    "Content-Disposition": 'attachment; filename="unsafe.pdf"',
  },
});
export const emptyResponse = new Response(null, { status: 404 });

void user;
