import { sql } from "drizzle-orm";

import { BROWSER_SITE_GRANT_ORIGIN_CHARS } from "@stll/api-contract/browser-site-grants";
import {
  BROWSER_SITE_NOTE_KINDS,
  BROWSER_SITE_NOTE_STEP_CHARS,
  BROWSER_SITE_NOTE_TEXT_CHARS,
} from "@stll/api-contract/browser-site-notes";

import {
  chatBrowserSiteNotePolicies,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  timestamptz,
  user,
} from "./common";

const NOTE_KIND_SQL_VALUES = BROWSER_SITE_NOTE_KINDS.map((kind) =>
  sql.raw(`'${kind}'`),
);

/**
 * A research note the agent keeps about one website's mechanics for one
 * member (`browser-site-notes.ts` in the API contract), keyed by the
 * website's exact HTTPS origin like a website approval. It holds how the
 * site works, never the member's work.
 */
export const chatBrowserSiteNotes = p.pgTable(
  "chat_browser_site_notes",
  {
    id: pUuid<"chatBrowserSiteNote">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Exact origin (`https://host[:port]`) of the website the note is about. */
    origin: p
      .varchar("origin", { length: BROWSER_SITE_GRANT_ORIGIN_CHARS })
      .notNull(),
    /** Whether the note records a way that works, one that failed, or a fix. */
    kind: p.text("kind", { enum: BROWSER_SITE_NOTE_KINDS }).notNull(),
    /** The step on the website the note is about, in a few words. */
    step: p.varchar("step", { length: BROWSER_SITE_NOTE_STEP_CHARS }).notNull(),
    /** What to do or avoid at that step. */
    text: p.varchar("text", { length: BROWSER_SITE_NOTE_TEXT_CHARS }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    /**
     * When the agent last followed the note and it worked, or wrote it. The
     * least recently confirmed note goes first when the website's notes are
     * over their cap; nothing expires by age.
     */
    confirmedAt: timestamptz("confirmed_at").notNull().defaultNow(),
  },
  (table) => [
    // Writing a note already kept confirms it instead of keeping it twice.
    p
      .unique("chat_browser_site_notes_content_key")
      .on(
        table.organizationId,
        table.userId,
        table.origin,
        table.kind,
        table.step,
        table.text,
      ),
    // The website's notes by confirmation: the read order and the prune.
    p
      .index("chat_browser_site_notes_site_idx")
      .on(table.organizationId, table.userId, table.origin, table.confirmedAt),
    p.check(
      "chat_browser_site_notes_https_origin_check",
      sql`${table.origin} LIKE 'https://%'`,
    ),
    p.check(
      "chat_browser_site_notes_kind_check",
      sql`${table.kind} IN (${sql.join(NOTE_KIND_SQL_VALUES, sql`, `)})`,
    ),
    ...chatBrowserSiteNotePolicies(),
  ],
);
