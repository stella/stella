// Passive regression fixture covering every security-guards rule.

// oxlint-disable-next-line security-guards/no-unscoped-user-query -- fixture: importing member without using its organization fields is not a scoped query
import { member, user } from "@/api/db/auth-schema";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
// oxlint-disable-next-line security-guards/require-secure-document-response -- fixture: handlers must not assemble the document security policy manually
import { RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS } from "@/api/lib/security-headers";
import { sanitizeHref } from "@/lib/sanitize-href";

declare const file: { name: string };
declare const item: { url: string };
declare const sanitizedName: string;
declare const bytes: Uint8Array;
declare const buildHref: (value: string) => string;

// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: raw upload name reaches persisted filename
export const rawFile = { fileName: file.name };
export const safeFile = { fileName: sanitizedName };

const rawAlias = file.name;
// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: a local alias must not launder an upload filename
export const rawAliasedFile = { fileName: rawAlias };

const { name } = file;
// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: destructuring must not launder an upload filename
export const rawDestructuredFile = { fileName: name };

const { name: renamedName } = file;
// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: renamed destructuring must preserve filename taint
export const rawRenamedDestructuredFile = { fileName: renamedName };

// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: string composition preserves raw filename taint
export const rawTemplatedFile = { fileName: `copy-${file.name}` };

export const UnsafeLink = () => (
  // oxlint-disable-next-line security-guards/no-unsanitized-href -- fixture: external member value may contain a script URL
  <a href={item.url}>Open</a>
);
const unsafeAlias = item.url;
export const UnsafeAliasedLink = () => (
  // oxlint-disable-next-line security-guards/no-unsanitized-href -- fixture: a local alias is not proof of a safe protocol
  <a href={unsafeAlias}>Open</a>
);
export const UnsafeBuiltLink = () => (
  // oxlint-disable-next-line security-guards/no-unsanitized-href -- fixture: an arbitrary function call is not a sanitizer
  <a href={buildHref(item.url)}>Open</a>
);
export const SafeLink = () => <a href={sanitizeHref(item.url)}>Open</a>;

const shadowedMemberReferences = (member: {
  organizationId: string;
  userId: string;
}) => [member.userId, member.organizationId];

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
void member;
void RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS;
void shadowedMemberReferences;
