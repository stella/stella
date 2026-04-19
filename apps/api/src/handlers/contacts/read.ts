import { Result } from "better-result";
import { and, count, eq, gt, ilike, or } from "drizzle-orm";
import { t } from "elysia";

import { contacts, workspaces } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { escapeLike } from "@/api/lib/escape-like";

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
  id: string;
};

const decodeCursor = (cursor: string): DecodedCursor | null => {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const [displayName, id] = decoded.split("\0");
    if (!displayName || !id) {
      return null;
    }
    return { displayName, id };
  } catch {
    return null;
  }
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

    const items = yield* Result.await(
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
            matterCount: count(workspaces.id),
          })
          .from(contacts)
          .leftJoin(
            workspaces,
            and(
              eq(workspaces.clientId, contacts.id),
              eq(workspaces.status, "active"),
            ),
          )
          .where(and(...conditions))
          .groupBy(contacts.id)
          .orderBy(contacts.displayName, contacts.id)
          .limit(limit + 1),
      ),
    );

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const lastItem = page.at(-1);
    const nextCursor =
      hasMore && lastItem
        ? encodeCursor(lastItem.displayName, lastItem.id)
        : null;

    return Result.ok({ items: page, nextCursor });
  },
);

export default readContacts;
