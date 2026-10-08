import {
  bytea,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
  userOrganizationPolicies,
} from "./common";

const tableOwner = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_entries'::regclass)`;

/** What the law search page records: a typed query, or an opened document. */
export const SEARCH_HISTORY_KINDS = ["search", "decision", "statute"] as const;

export type SearchHistoryKind = (typeof SEARCH_HISTORY_KINDS)[number];

/**
 * A user's own law search history in one organization: what they searched
 * for and which decisions and statutes they opened. Nobody else reads it, an
 * administrator included, and nothing else consumes it.
 *
 * The entry itself (the query, or the opened document's id, title and path)
 * is encrypted at rest like extracted document content. Repeats are found by
 * `lookup_key`, a keyed hash of the normalized entry, so using a query again
 * bumps `last_used_at` and `use_count` on its row instead of adding one.
 */
export const searchHistoryEntries = p.pgTable(
  "search_history_entries",
  {
    id: pUuid<"searchHistoryEntry">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: p.text("kind", { enum: SEARCH_HISTORY_KINDS }).notNull(),
    courtId: p.varchar("court_id", { length: 128 }),
    statuteNumber: p.varchar("statute_number", { length: 32 }),
    statuteYear: p.varchar("statute_year", { length: 4 }),
    lookupKey: p.varchar("lookup_key", { length: 64 }).notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    firstUsedAt: timestamptz("first_used_at").notNull().defaultNow(),
    lastUsedAt: timestamptz("last_used_at").notNull().defaultNow(),
    useCount: p.integer("use_count").notNull().default(1),
  },
  (table) => [
    p
      .uniqueIndex("search_history_entries_owner_lookup_idx")
      .on(table.organizationId, table.userId, table.kind, table.lookupKey),
    p
      .index("search_history_entries_owner_recent_idx")
      .on(table.organizationId, table.userId, table.lastUsedAt, table.id),
    p
      .index("search_history_entries_owner_kind_recent_idx")
      .on(
        table.organizationId,
        table.userId,
        table.kind,
        table.lastUsedAt,
        table.id,
      ),
    p.check(
      "search_history_entries_kind_check",
      sql`${table.kind} IN (${sql.join(
        SEARCH_HISTORY_KINDS.map((kind) => sql`${kind}`),
        sql`, `,
      )})`,
    ),
    p.check(
      "search_history_entries_use_count_check",
      sql`${table.useCount} >= 1`,
    ),
    p.check(
      "search_history_entries_used_order_check",
      sql`${table.firstUsedAt} <= ${table.lastUsedAt}`,
    ),
    ...userOrganizationPolicies(),
    // Row security is forced, so the owning role (member removal, account
    // deletion, the review reset) is admitted by name; the app role never is.
    p.pgPolicy("search_history_entries_owner", {
      for: "all",
      to: "public",
      using: tableOwner,
      withCheck: tableOwner,
    }),
  ],
);
