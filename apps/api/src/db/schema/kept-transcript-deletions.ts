import { denyStellaAccessPolicies } from "@/api/db/rls";

import { p, sql, timestamptz } from "./common";

/** The ElevenLabs environments a kept transcript can live in. */
export const KEPT_TRANSCRIPT_ENVIRONMENTS = ["default", "us", "eu"] as const;

const KEPT_TRANSCRIPT_ENVIRONMENT_SQL_VALUES = KEPT_TRANSCRIPT_ENVIRONMENTS.map(
  (environment) => sql.raw(`'${environment}'`),
);

const ownerAccess = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.kept_transcript_deletions'::regclass)`;

/**
 * Transcripts a transcription provider kept for a request made without zero
 * retention, still to be deleted there. A row holds the provider's id only,
 * never audio or text, and exists until the provider confirms the delete;
 * the deletion task retries it with backoff and reports one that stays.
 */
export const keptTranscriptDeletions = p.pgTable.withRLS(
  "kept_transcript_deletions",
  {
    /** The id the provider issued for the transcript it kept. */
    transcriptionId: p.text("transcription_id").primaryKey(),
    /** The provider environment the transcript lives in. */
    environment: p
      .text("environment", { enum: KEPT_TRANSCRIPT_ENVIRONMENTS })
      .notNull(),
    /** Delete attempts that settled without the provider confirming. */
    attempts: p.integer().notNull().default(0),
    /** When the deletion task may next try, or a lease's end while it does. */
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    /** Why the last attempt did not delete it, such as `http_503`. */
    lastErrorCode: p.varchar("last_error_code", { length: 64 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("kept_transcript_deletions_due_idx").on(table.nextAttemptAt),
    p.index("kept_transcript_deletions_created_idx").on(table.createdAt),
    p.check(
      "kept_transcript_deletions_environment_domain",
      sql`environment IN (${sql.join(KEPT_TRANSCRIPT_ENVIRONMENT_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "kept_transcript_deletions_transcription_id_shape",
      sql`transcription_id ~ '^[A-Za-z0-9_-]{1,128}$'`,
    ),
    p.check(
      "kept_transcript_deletions_attempts_nonnegative",
      sql`attempts >= 0`,
    ),
    p.pgPolicy("kept_transcript_deletions_owner_access", {
      for: "all",
      to: "public",
      using: ownerAccess,
      withCheck: ownerAccess,
    }),
    ...denyStellaAccessPolicies(),
  ],
);
