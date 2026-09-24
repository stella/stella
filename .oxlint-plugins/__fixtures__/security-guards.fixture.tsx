// Passive regression fixture covering every security-guards rule.

import { sanitizeFilename as foreignSanitizeFilename } from "unrelated-filename";
import { sanitizeHref as foreignSanitizeHref } from "unrelated-href";

import * as authSchema from "@/api/db/auth-schema";
import { member, user, user as authUser } from "@/api/db/auth-schema";
import * as filenames from "@/api/lib/sanitize-filename";
import {
  sanitizeFilename,
  sanitizeFilename as cleanFilename,
} from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
// oxlint-disable-next-line security-guards/require-secure-document-response -- fixture: handlers must not assemble the document security policy manually
import { RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS } from "@/api/lib/security-headers";

// oxlint-disable-next-line security-guards/require-secure-document-response -- fixture: a relative specifier names the same security-headers module
import { RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS as relativeHeaders } from "../../apps/api/src/lib/security-headers";
import { readerHref } from "../../apps/web/src/components/legal-reader/source-link-policy";
import * as hrefs from "../../apps/web/src/lib/sanitize-href";
import {
  sanitizeHref,
  sanitizeHref as cleanHref,
} from "../../apps/web/src/lib/sanitize-href";

declare const file: { name: string };
declare const body: {
  files: { name: string }[];
  upload: { name: string };
};
declare const part: { filename?: string };
declare const query: { name: string };
declare const content: { fileName: string };
declare const record: { fileName: string; filename: string };
declare const item: { url: string };
declare const sanitizedName: string;
declare const bytes: Uint8Array;
declare const buildHref: (value: string) => string;

// ── no-raw-filename-write ──────────────────────────────────

// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: raw upload name reaches persisted filename
export const rawFile = { fileName: file.name };
// expect-clean: security-guards/no-raw-filename-write
export const safeFile = { fileName: sanitizedName };
// expect-clean: security-guards/no-raw-filename-write
export const readBackFile = { fileName: content.fileName };
// expect-clean: security-guards/no-raw-filename-write
export const sanitizedFile = { fileName: sanitizeFilename(file.name) };
// expect-clean: security-guards/no-raw-filename-write
export const aliasedSanitizedFile = { fileName: cleanFilename(file.name) };
// expect-clean: security-guards/no-raw-filename-write
export const namespaceSanitizedFile = {
  fileName: filenames.sanitizeFilename(file.name),
};

export const foreignSanitizedFile = {
  // oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: a same-named export of another module is not the sanitizer
  fileName: foreignSanitizeFilename(file.name),
};

const rawAlias = file.name;
// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: a local alias keeps the upload filename
export const rawAliasedFile = { fileName: rawAlias };

const { name } = file;
// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: destructured upload filename
export const rawDestructuredFile = { fileName: name };

const { name: renamedName } = file;
// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: renamed destructured upload filename
export const rawRenamedDestructuredFile = { fileName: renamedName };

// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: string composition keeps the raw filename
export const rawTemplatedFile = { fileName: `copy-${file.name}` };

// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: member chain of request input
export const rawMemberChainFile = { fileName: body.upload.name };

// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: string method on a raw filename
export const rawTrimmedFile = { fileName: body.upload.name.trim() };

// oxlint-disable-next-line security-guards/no-raw-filename-write, typescript/no-non-null-assertion -- fixture: non-null assertion on a multipart filename
export const rawAssertedPart = { fileName: part.filename! };

// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: lowercase filename key
export const rawLowercaseKey = { filename: part.filename };

// oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: element of an uploaded file list
export const rawElementFile = { fileName: body.files.at(0)?.name };

export const rawDestructuredParameter = ({
  body: { fileName },
}: {
  body: { fileName: string };
}) =>
  // oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: destructured handler parameter
  ({ fileName });

export const rawContextBody = (ctx: { body: { fileName: string } }) =>
  // oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: request body read from a handler context
  ({ fileName: ctx.body.fileName });

export const rawIteratedFiles = () => {
  const out: { fileName: string }[] = [];
  for (const upload of body.files) {
    // oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: iterated upload list
    out.push({ fileName: upload.name });
  }
  return out;
};

export const assignRawFilename = () => {
  // oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: member assignment
  record.fileName = query.name;
  // oxlint-disable-next-line security-guards/no-raw-filename-write, typescript/dot-notation -- fixture: computed member assignment
  record["filename"] = file.name;
  // expect-clean: security-guards/no-raw-filename-write
  record.fileName = sanitizeFilename(query.name);
};

export const shadowedSanitizer = (
  // oxlint-disable-next-line eslint/no-shadow -- fixture: a local binding named like the sanitizer
  sanitizeFilename: (value: string) => string,
) =>
  // oxlint-disable-next-line security-guards/no-raw-filename-write -- fixture: a parameter named like the sanitizer is not the sanitizer
  ({ fileName: sanitizeFilename(file.name) });

// ── no-unsanitized-href ────────────────────────────────────

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
export const ForeignSanitizedLink = () => (
  // oxlint-disable-next-line security-guards/no-unsanitized-href -- fixture: a same-named export of another module is not the sanitizer
  <a href={foreignSanitizeHref(item.url)}>Open</a>
);
// expect-clean: security-guards/no-unsanitized-href
export const SafeLink = () => <a href={sanitizeHref(item.url)}>Open</a>;
// expect-clean: security-guards/no-unsanitized-href
export const AliasedSafeLink = () => <a href={cleanHref(item.url)}>Open</a>;
// expect-clean: security-guards/no-unsanitized-href
export const NamespaceSafeLink = () => (
  <a href={hrefs.sanitizeHref(item.url)}>Open</a>
);
export const SafeReaderLink = () => (
  // expect-clean: security-guards/no-unsanitized-href
  <a href={readerHref(item.url, { publisherHosts: [] })}>Open</a>
);
// oxlint-disable-next-line eslint/no-shadow -- fixture: a local binding must not satisfy the sanitizer scope guard
const localReaderHref = (readerHref: (value: string) => string | undefined) => (
  // oxlint-disable-next-line security-guards/no-unsanitized-href -- fixture: a sanitizer name bound to anything but its import is not a sanitizer
  <a href={readerHref(item.url)}>Open</a>
);
export const ShadowedReaderLink = () => localReaderHref((value) => value);

// ── no-unscoped-user-query ─────────────────────────────────

type Query = {
  from: (table: unknown) => Query;
  innerJoin: (table: unknown, on: unknown) => Query;
  where: (condition: unknown) => Query;
};
type Insert = {
  onConflictDoNothing: () => Insert;
  onConflictDoUpdate: (config: unknown) => Insert;
  returning: () => Insert;
  values: (row: unknown) => Insert;
};
declare const db: { insert: (table: unknown) => Insert; select: () => Query };
declare const and: (...conditions: unknown[]) => unknown;
declare const eq: (left: unknown, right: unknown) => unknown;
declare const organizationId: string;
declare const userId: string;

// oxlint-disable-next-line security-guards/no-unscoped-user-query -- fixture: user table read without membership scoping
export const unscopedUsers = db.select().from(user);

// oxlint-disable-next-line security-guards/no-unscoped-user-query -- fixture: aliased import of the user table
export const aliasedUnscopedUsers = db.select().from(authUser);

// oxlint-disable-next-line security-guards/no-unscoped-user-query -- fixture: namespace member of the auth schema
export const namespaceUnscopedUsers = db.select().from(authSchema.user);

// oxlint-disable-next-line security-guards/no-unscoped-user-query -- fixture: user id alone does not bind the organization
export const partiallyScopedUsers = db
  .select()
  .from(user)
  .innerJoin(member, eq(member.userId, user.id))
  .where(eq(user.id, userId));

// expect-clean: security-guards/no-unscoped-user-query
export const scopedUsers = db
  .select()
  .from(user)
  .innerJoin(
    member,
    and(eq(member.userId, user.id), eq(member.organizationId, organizationId)),
  );

// expect-clean: security-guards/no-unscoped-user-query
export type UserRow = typeof user.$inferSelect;

export const scopedThroughSubquery = () => {
  const organizationMembers = db
    .select()
    .from(member)
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
    );
  // expect-clean: security-guards/no-unscoped-user-query
  return db.select().from(organizationMembers).innerJoin(user, userId);
};

// expect-clean: security-guards/no-unscoped-user-query
const scopedSelection = { name: user.name };
export const scopedSelectionQuery = db
  .select()
  .from(scopedSelection)
  .innerJoin(
    member,
    and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
  );

// oxlint-disable-next-line security-guards/no-unscoped-user-query -- fixture: a select map read by an unscoped query
const unscopedSelection = { name: user.name };
export const unscopedSelectionQuery = db.select().from(unscopedSelection);

// expect-clean: security-guards/no-unscoped-user-query
export const insertedUser = db.insert(user).values({ id: userId });

// expect-clean: security-guards/no-unscoped-user-query
export const insertedUserOnce = db
  .insert(authSchema.user)
  .values({ id: userId })
  .onConflictDoNothing();

// oxlint-disable-next-line security-guards/no-unscoped-user-query -- fixture: an insert that hands rows back reads them
export const insertedUserReturning = db
  .insert(user)
  .values({ id: userId })
  .returning();

// oxlint-disable-next-line security-guards/no-unscoped-user-query -- fixture: an upsert rewrites whichever row already holds the key
export const upsertedUser = db
  .insert(user)
  .values({ id: userId })
  .onConflictDoUpdate({ set: { name: "" }, target: user.id });

// oxlint-disable-next-line security-guards/no-unscoped-user-query -- fixture: an insert fed from an unscoped read still reads
export const insertedFromRead = db.insert(user).values(db.select().from(user));

// oxlint-disable-next-line eslint/no-shadow -- fixture: a shadowed binding must not satisfy the imported-member scope guard
const shadowedMemberReferences = (member: {
  organizationId: string;
  userId: string;
}) =>
  // oxlint-disable-next-line security-guards/no-unscoped-user-query -- fixture: a parameter named member is not the membership table
  db.select().from(user).where(and(member.userId, member.organizationId));

// ── require-secure-document-response ──────────────────────

export const unsafeDocumentResponse =
  // oxlint-disable-next-line security-guards/require-secure-document-response -- fixture: direct attachment Response outside the typed boundary
  new Response(bytes, {
    headers: { "Content-Disposition": 'attachment; filename="unsafe.pdf"' },
  });
// expect-clean: security-guards/require-secure-document-response
export const safeDocumentResponse = secureDocumentResponse({
  body: bytes,
  contentType: "application/pdf",
  disposition: "attachment",
  fileName: sanitizeFilename("safe.pdf"),
});
// expect-clean: security-guards/require-secure-document-response
export const emptyResponse = new Response(null, { status: 404 });

void RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS;
void relativeHeaders;
void shadowedMemberReferences;
