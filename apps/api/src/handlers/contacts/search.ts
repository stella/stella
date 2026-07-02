import { Result } from "better-result";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { normalizeSearchText } from "@stll/text-normalize";

import { contacts } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { escapeLike } from "@/api/lib/escape-like";

const SEARCH_LIMIT = 20;

const searchContactsQuerySchema = t.Object({
  q: t.String({ minLength: 1 }),
  type: t.Optional(t.Union([t.Literal("person"), t.Literal("organization")])),
});

const searchContacts = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "pending" },
    query: searchContactsQuerySchema,
  },
  async function* ({ safeDb, session, query }) {
    const normalized = normalizeSearchText(query.q);
    if (normalized.length === 0) {
      return Result.ok({ items: [] });
    }
    const pattern = `%${escapeLike(normalized)}%`;

    const conditions = [
      eq(contacts.organizationId, session.activeOrganizationId),
      or(
        ilike(sql`arabic_normalize(${contacts.displayName})`, pattern),
        ilike(sql`arabic_normalize(${contacts.firstName})`, pattern),
        ilike(sql`arabic_normalize(${contacts.lastName})`, pattern),
        ilike(sql`arabic_normalize(${contacts.organizationName})`, pattern),
      ),
    ];

    if (query.type) {
      conditions.push(eq(contacts.type, query.type));
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
            color: contacts.color,
          })
          .from(contacts)
          .where(and(...conditions))
          .orderBy(contacts.displayName)
          .limit(SEARCH_LIMIT),
      ),
    );

    return Result.ok({ items });
  },
);

export default searchContacts;
