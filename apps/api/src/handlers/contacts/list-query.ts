import { and, count, eq, gt, ilike, or } from "drizzle-orm";

import type { ContactType } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { contacts, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { brandPersistedContactId } from "@/api/lib/safe-id-boundaries";

type ContactRow = typeof contacts.$inferSelect;

// Columns intentionally not sent by this page. The address book is a
// directory summary, not the full contact record — `contacts.get` returns
// the rest. A new schema column must either be added to the `.select()`
// below or added here with a reason, or the totality check further down
// fails to typecheck.
const UNPROJECTED_CONTACT_LIST_COLUMNS = [
  // Tenant scope, implied by the caller's active organization.
  "organizationId",
  // Person-only fields the directory summary omits; full detail is on
  // contacts.get.
  "prefix",
  "middleName",
  "suffix",
  // Free-text notes are a detail-view field, not a directory summary field.
  "notes",
  "addresses",
  "metadata",
  // Billing fields belong to the invoicing surface, not the address-book
  // summary; contacts.get returns them.
  "registrationNumber",
  "taxId",
  "bankAccounts",
  "billingAddress",
  "defaultHourlyRate",
  "currency",
  "paymentTermDays",
  // Attorney assignment surfaces on the matter (workspace) contact fields,
  // not the standalone directory row.
  "originatingAttorneyId",
  "responsibleAttorneyId",
  // Authorship/edit metadata is a detail-view field.
  "createdBy",
  "updatedAt",
] as const satisfies readonly (keyof ContactRow)[];

type ListContactsQuery = {
  cursor?: string;
  limit?: number;
  q?: string;
  type?: ContactType;
};

type DecodedCursor = {
  displayName: string;
  id: SafeId<"contact">;
};

const CONTACT_DISPLAY_NAME_MAX_LENGTH = 512;
const MAX_JSON_ESCAPE_LENGTH = 6;
const UUID_LENGTH = 36;
const JSON_TUPLE_OVERHEAD = 7;

// A control character or lone surrogate can occupy six ASCII bytes after
// JSON escaping. Keep the request bound large enough for every cursor this
// producer can emit from the varchar(512) display-name column.
export const CONTACT_CURSOR_MAX_LENGTH = Math.ceil(
  ((CONTACT_DISPLAY_NAME_MAX_LENGTH * MAX_JSON_ESCAPE_LENGTH +
    UUID_LENGTH +
    JSON_TUPLE_OVERHEAD) *
    4) /
    3,
);

// Legacy cursors were base64 of `displayName\0uuid`; the current form is the
// base64url JSON tuple `encodePaginationCursor` emits. Keep the fallback so an
// in-flight legacy cursor does not silently restart pagination at page one.
const LEGACY_CONTACT_CURSOR_SEPARATOR = "\0";

const decodeLegacyContactCursor = (cursor: string): DecodedCursor | null => {
  const decoded = Buffer.from(cursor, "base64").toString("utf-8");
  const separatorIndex = decoded.indexOf(LEGACY_CONTACT_CURSOR_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }
  const displayName = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (!isUuidPaginationCursorPart(id)) {
    return null;
  }
  return { displayName, id: brandPersistedContactId(id) };
};

const decodeCursor = (cursor: string): DecodedCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts === null) {
    return decodeLegacyContactCursor(cursor);
  }
  const displayName = parts.at(0);
  const id = parts.at(1);
  if (typeof displayName !== "string" || !isUuidPaginationCursorPart(id)) {
    return null;
  }
  return { displayName, id: brandPersistedContactId(id) };
};

const encodeCursor = (displayName: string, id: string): string =>
  encodePaginationCursor([displayName, id]);

// The shape the `.select({...})` below must project, plus the one
// aggregate (`clientMatterCount`) that traces back to no single column.
type ContactListItem = Pick<
  ContactRow,
  | "id"
  | "type"
  | "displayName"
  | "firstName"
  | "lastName"
  | "organizationName"
  | "emails"
  | "phones"
  | "tags"
  | "color"
  | "createdAt"
> & { clientMatterCount: number };

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column, aside from the join-derived
// `clientMatterCount`.
type MissingProjectedContactListColumn = UnprojectedColumns<
  ContactRow,
  ContactListItem,
  (typeof UNPROJECTED_CONTACT_LIST_COLUMNS)[number]
>;
type UnexpectedProjectedContactListColumn = UnbackedProjectionKeys<
  ContactRow,
  Omit<ContactListItem, "clientMatterCount">
>;

true satisfies MissingProjectedContactListColumn extends never ? true : never;
true satisfies UnexpectedProjectedContactListColumn extends never
  ? true
  : never;

/** One tenant-scoped contact-directory query shared by HTTP and MCP. */
export const listContactsPage = async ({
  safeDb,
  organizationId,
  query,
}: {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  query: ListContactsQuery;
}) => {
  const result = await safeDb(async (tx) => {
    const limit = Math.min(
      query.limit ?? LIMITS.contactsPageSizeDefault,
      LIMITS.contactsPageSizeMax,
    );
    const conditions = [eq(contacts.organizationId, organizationId)];

    if (query.type) {
      conditions.push(eq(contacts.type, query.type));
    }
    if (query.q) {
      conditions.push(ilike(contacts.displayName, `%${escapeLike(query.q)}%`));
    }
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (decoded) {
        const cursorCondition = or(
          gt(contacts.displayName, decoded.displayName),
          and(
            eq(contacts.displayName, decoded.displayName),
            gt(contacts.id, decoded.id),
          ),
        );
        if (cursorCondition) {
          conditions.push(cursorCondition);
        }
      }
    }

    const rows = await tx
      .select({
        id: contacts.id,
        type: contacts.type,
        displayName: contacts.displayName,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        organizationName: contacts.organizationName,
        emails: contacts.emails,
        phones: contacts.phones,
        tags: contacts.tags,
        color: contacts.color,
        createdAt: contacts.createdAt,
        clientMatterCount: count(workspaces.id),
      })
      .from(contacts)
      .leftJoin(
        workspaces,
        and(
          eq(workspaces.clientId, contacts.id),
          eq(workspaces.organizationId, organizationId),
        ),
      )
      .where(and(...conditions))
      .groupBy(contacts.id)
      .orderBy(contacts.displayName, contacts.id)
      .limit(limit + 1);

    // Ties the `.select({...})` above to `ContactListItem`: if either drops
    // a field the other still names, this check stops typechecking.
    const projectedRows = rows satisfies ContactListItem[];

    return createCursorPage({
      rows: projectedRows,
      limit,
      cursorForItem: (item) => encodeCursor(item.displayName, item.id),
    });
  });
  return result;
};
