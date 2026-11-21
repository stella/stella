import {
  bytea,
  organization,
  p,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
  userOrganizationPolicies,
} from "./common";

const tableOwner = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.dictation_learned_fixes'::regclass)`;

/**
 * The spelling fixes dictation learned from how one member corrects it in
 * one organization, so every device of theirs applies the same ones. A fix
 * can name a client or a party, so the row is the member's alone (an
 * administrator never reads it) and its content (the fixes and the ids of
 * the changes recently applied) is encrypted at rest like document content.
 * One row per member: a write replaces it only at the `revision` it read,
 * so devices syncing at once apply their changes in turn.
 */
export const dictationLearnedFixes = p.pgTable(
  "dictation_learned_fixes",
  {
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * How often the member deleted everything stella learned; changes a
     * device made before the latest deletion are dropped.
     */
    generation: p.integer("generation").notNull().default(0),
    /** Bumped by every write; a write made from an older read is retried. */
    revision: p.integer("revision").notNull().default(0),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({ columns: [table.organizationId, table.userId] }),
    p.check(
      "dictation_learned_fixes_generation_check",
      sql`${table.generation} >= 0`,
    ),
    p.check(
      "dictation_learned_fixes_revision_check",
      sql`${table.revision} >= 0`,
    ),
    ...userOrganizationPolicies(),
    // Row security is forced, so the owning role (member removal, account
    // deletion, the review reset) is admitted by name; the app role never is.
    p.pgPolicy("dictation_learned_fixes_owner", {
      for: "all",
      to: "public",
      using: tableOwner,
      withCheck: tableOwner,
    }),
  ],
);
