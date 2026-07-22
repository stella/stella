import { and, count, eq, gt, ilike, or } from "drizzle-orm";

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
import { brandPersistedContactId } from "@/api/lib/safe-id-boundaries";

type ListContactsQuery = {
  cursor?: string;
  limit?: number;
  q?: string;
  type?: "person" | "organization";
};

type DecodedCursor = {
  displayName: string;
  id: SafeId<"contact">;
};

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

    return createCursorPage({
      rows,
      limit,
      cursorForItem: (item) => encodeCursor(item.displayName, item.id),
    });
  });
  return result;
};
