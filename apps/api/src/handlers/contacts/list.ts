import { Result } from "better-result";
import { and, count, eq, gt, ilike, or } from "drizzle-orm";
import { t } from "elysia";

import { contacts, workspaces } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationLimit } from "@/api/lib/custom-schema";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedContactId } from "@/api/lib/safe-id-boundaries";

const readContactsQuerySchema = t.Object({
  limit: t.Optional(tPaginationLimit(LIMITS.contactsPageSizeMax)),
  cursor: t.Optional(t.String()),
  type: t.Optional(t.Union([t.Literal("person"), t.Literal("organization")])),
  q: t.Optional(t.String()),
});

type DecodedCursor = {
  displayName: string;
  id: SafeId<"contact">;
};

// Legacy cursors were base64 of `displayName\0uuid`; the current form is the
// base64url JSON tuple `encodePaginationCursor` emits. `decodePaginationCursor`
// returns null for the legacy shape (its NUL-delimited payload is not JSON), so
// fall back to it there and an in-flight cursor survives the format change
// instead of silently restarting pagination at page 1 (duplicate contacts).
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

const readContacts = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "capability", reason: "contact_directory" },
    access: "read",
    query: readContactsQuerySchema,
  },
  async function* ({ safeDb, session, query }) {
    const limit = Math.min(
      query.limit ?? LIMITS.contactsPageSizeDefault,
      LIMITS.contactsPageSizeMax,
    );

    const conditions = [
      eq(contacts.organizationId, session.activeOrganizationId),
    ];

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

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
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
              eq(workspaces.organizationId, session.activeOrganizationId),
            ),
          )
          .where(and(...conditions))
          .groupBy(contacts.id)
          .orderBy(contacts.displayName, contacts.id)
          .limit(limit + 1),
      ),
    );

    return Result.ok(
      createCursorPage({
        rows,
        limit,
        cursorForItem: (item) => encodeCursor(item.displayName, item.id),
      }),
    );
  },
);

export default readContacts;
