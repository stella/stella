import { PUBLIC_COUNTRIES } from "@stll/api-contract/public-country-capability";

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
 * The entry itself (the query, or the opened document's id, title, path
 * and plain document identity) is encrypted at rest like document content. Repeats are found by
 * `lookup_key`, a keyed hash of the normalized entry, so using a query again
 * bumps `last_used_at` and `use_count` on its row instead of adding one.
 *
 * `jurisdiction` is the country the entry belongs to: the one a search ran
 * in, or the one whose page an opened document lives on. The law page lists
 * one country's history. It is null only on entries recorded before history
 * was kept per country: old searches, which never said where they ran, and
 * opened documents until the online jurisdiction repair classifies their path.
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
    jurisdiction: p.varchar("jurisdiction", { length: 8 }),
    /** Set when an old encrypted document cannot be assigned a country. */
    jurisdictionRepairFailedAt: timestamptz("jurisdiction_repair_failed_at"),
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
      .index("search_history_entries_owner_jurisdiction_recent_idx")
      .on(
        table.organizationId,
        table.userId,
        table.jurisdiction,
        table.lastUsedAt,
        table.id,
      ),
    p
      .index("search_history_entries_owner_kind_recent_idx")
      .on(
        table.organizationId,
        table.userId,
        table.kind,
        table.lastUsedAt,
        table.id,
      ),
    p
      .index("search_history_entries_legacy_documents_pending_idx")
      .on(table.id)
      .where(sql`${table.jurisdiction} IS NULL AND ${table.kind} <> 'search'`),
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
    p.check(
      "search_history_entries_jurisdiction_check",
      sql`${table.jurisdiction} IS NULL OR ${table.jurisdiction} IN (${sql.join(
        PUBLIC_COUNTRIES.map((country) => sql`${country}`),
        sql`, `,
      )})`,
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

/** Serializes one owner's writes and retains the cutoff from their last clear. */
export const searchHistoryOwners = p.pgTable(
  "search_history_owners",
  {
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clearedAt: timestamptz("cleared_at"),
    /** Blocks old searches that had no country after any country clear. */
    legacyClearedAt: timestamptz("legacy_cleared_at"),
    /** Oldest imports excluded after bounded tombstone compaction. */
    tombstoneCutoffAt: timestamptz("tombstone_cutoff_at"),
  },
  (table) => [
    p.primaryKey({ columns: [table.organizationId, table.userId] }),
    ...userOrganizationPolicies(),
    p.pgPolicy("search_history_owners_owner", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_owners'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_owners'::regclass)`,
    }),
  ],
);

/** A country clear blocks old uses of that country without affecting others. */
export const searchHistoryJurisdictionClears = p.pgTable(
  "search_history_jurisdiction_clears",
  {
    organizationId: safeOrganizationId("organization_id").notNull(),
    userId: p.text("user_id").notNull(),
    jurisdiction: p.varchar("jurisdiction", { length: 8 }).notNull(),
    clearedAt: timestamptz("cleared_at").notNull(),
  },
  (table) => [
    p
      .foreignKey({
        name: "search_history_jurisdiction_clears_org_fk",
        columns: [table.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "search_history_jurisdiction_clears_user_fk",
        columns: [table.userId],
        foreignColumns: [user.id],
      })
      .onDelete("cascade"),
    p.primaryKey({
      name: "search_history_jurisdiction_clears_pk",
      columns: [table.organizationId, table.userId, table.jurisdiction],
    }),
    p
      .foreignKey({
        name: "search_history_jurisdiction_clears_owner_fk",
        columns: [table.organizationId, table.userId],
        foreignColumns: [
          searchHistoryOwners.organizationId,
          searchHistoryOwners.userId,
        ],
      })
      .onDelete("cascade"),
    p.check(
      "search_history_jurisdiction_clears_country_check",
      sql`${table.jurisdiction} IN (${sql.join(
        PUBLIC_COUNTRIES.map((country) => sql`${country}`),
        sql`, `,
      )})`,
    ),
    ...userOrganizationPolicies(),
    p.pgPolicy("search_history_jurisdiction_clears_owner", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_jurisdiction_clears'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_jurisdiction_clears'::regclass)`,
    }),
  ],
);

/** A deleted identity's keyed hash and cutoff prevent stale imports restoring it. */
export const searchHistoryTombstones = p.pgTable(
  "search_history_tombstones",
  {
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: p.text("kind", { enum: SEARCH_HISTORY_KINDS }).notNull(),
    lookupKey: p.varchar("lookup_key", { length: 64 }).notNull(),
    deletedAt: timestamptz("deleted_at").notNull(),
  },
  (table) => [
    p.primaryKey({
      name: "search_history_tombstones_pk",
      columns: [
        table.organizationId,
        table.userId,
        table.kind,
        table.lookupKey,
      ],
    }),
    p
      .index("search_history_tombstones_owner_deleted_idx")
      .on(
        table.organizationId,
        table.userId,
        table.deletedAt,
        table.kind,
        table.lookupKey,
      ),
    p
      .foreignKey({
        name: "search_history_tombstones_owner_fk",
        columns: [table.organizationId, table.userId],
        foreignColumns: [
          searchHistoryOwners.organizationId,
          searchHistoryOwners.userId,
        ],
      })
      .onDelete("cascade"),
    p.check(
      "search_history_tombstones_kind_check",
      sql`${table.kind} IN (${sql.join(
        SEARCH_HISTORY_KINDS.map((kind) => sql`${kind}`),
        sql`, `,
      )})`,
    ),
    ...userOrganizationPolicies(),
    p.pgPolicy("search_history_tombstones_owner", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_tombstones'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_tombstones'::regclass)`,
    }),
  ],
);
