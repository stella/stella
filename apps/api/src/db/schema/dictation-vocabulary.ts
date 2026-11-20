import { MAX_DICTATION_TERM_LENGTH } from "@stll/api-contract/dictation-vocabulary";

import {
  organization,
  orgPolicies,
  p,
  pUuid,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
} from "./common";

const OWNER_CHECK = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.dictation_vocabulary_terms'::regclass)`;

/**
 * The organization's dictation words: names and terms an administrator
 * listed so every member's dictation spells them the organization's way.
 * Transcription and AI cleanup read the few a dictation needs
 * (`lib/dictation/organization-vocabulary.ts`); at most
 * `MAX_ORGANIZATION_DICTATION_TERMS` per organization.
 */
export const dictationVocabularyTerms = p.pgTable(
  "dictation_vocabulary_terms",
  {
    id: pUuid<"dictationVocabularyTerm">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The word as dictation should spell it: NFC, single spaces, trimmed. */
    term: p.varchar("term", { length: MAX_DICTATION_TERM_LENGTH }).notNull(),
    /** The word lowercased, so one spelling of a word is listed once. */
    termKey: p.text("term_key").notNull(),
    /** The member who added it; kept when they leave. */
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("dictation_vocabulary_terms_org_key_idx")
      .on(table.organizationId, table.termKey),
    p
      .index("dictation_vocabulary_terms_org_created_idx")
      .on(table.organizationId, table.createdAt.desc(), table.id.desc()),
    p.check(
      "dictation_vocabulary_terms_term_check",
      sql`length(btrim(${table.term})) > 0`,
    ),
    ...orgPolicies(),
    p.pgPolicy("dictation_vocabulary_terms_owner_access", {
      for: "all",
      to: "public",
      using: OWNER_CHECK,
      withCheck: OWNER_CHECK,
    }),
  ],
);
