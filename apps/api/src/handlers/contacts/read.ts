import { Result } from "better-result";
import { and, count, eq, gt, ilike, or } from "drizzle-orm";
import { t } from "elysia";

import { contacts, workspaces } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { escapeLike } from "@/api/lib/escape-like";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedContactId } from "@/api/lib/safe-id-boundaries";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const readContactsQuerySchema = t.Object({
  limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String()),
  type: t.Optional(t.Union([t.Literal("person"), t.Literal("organization")])),
  q: t.Optional(t.String()),
});

type DecodedCursor = {
  displayName: string;
  id: SafeId<"contact">;
};

const decodeCursor = (cursor: string): DecodedCursor | null => {
  const decodeResult = Result.try(() =>
    Buffer.from(cursor, "base64").toString("utf-8"),
  );
  if (Result.isError(decodeResult)) {
    return null;
  }

  const [displayName, id] = decodeResult.value.split("\0");
  if (!displayName || !id) {
    return null;
  }
  return { displayName, id: brandPersistedContactId(id) };
};

const encodeCursor = (displayName: string, id: string): string =>
  Buffer.from(`${displayName}\0${id}`, "utf-8").toString("base64");

const readContacts = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    query: readContactsQuerySchema,
  },
  async function* ({ safeDb, session, query }) {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

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
