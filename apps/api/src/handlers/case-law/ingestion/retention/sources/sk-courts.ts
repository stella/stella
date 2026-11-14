/**
 * Retention policy for the Slovak general courts.
 *
 * The adapter stores what the open-data service lists for a decision (the
 * listing item, its detail record, the court registry entry) and builds no
 * document: every row it writes carries an empty AST and defers its text.
 * The decision's PDF is fetched later by the document drain, which parses it
 * and writes the text onto the row directly, outside the pipeline, so neither
 * the PDF nor its parse ever passes through the pipeline's check. The drain
 * runs the same check itself, against the projection of the bytes it fetched
 * (`sk-courts-document.ts`).
 */
import {
  RETENTION_UNPARSED_REASON,
  type RetentionPolicy,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";

export const skCourtsRetention = {
  type: "unparsed",
  reason: RETENTION_UNPARSED_REASON.METADATA_ONLY,
} as const satisfies RetentionPolicy;
