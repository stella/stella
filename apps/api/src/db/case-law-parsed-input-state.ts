/**
 * `case_law_decisions.parsed_input_state`, introduced by migration
 * 20261030140000_case_law_parsed_input_state: whether the parse stored for a
 * decision was made from its current input. A trigger derives it on every
 * write through `case_law_parsed_input_state()`, the one owner of that
 * comparison; rows written before the trigger stay NULL until a backfill
 * derives them.
 *
 * The background replay's lag probe reads it through the index below: a
 * caught-up source answers from a few index pages instead of from every row.
 */
import type { OnlineIndexDeclaration } from "./online-ddl";
import type { OnlineStepIntroduction } from "./online-migration-connection";

export const CASE_LAW_REPLAY_PENDING_INDEX = {
  introducedBy: {
    type: "code",
    owner: "src/db/case-law-parsed-input-state.ts",
  },
  createSql:
    'CREATE INDEX CONCURRENTLY "case_law_decisions_replay_pending_idx" ON public."case_law_decisions" USING btree ("source_id", "parser_version", "parsed_input_state") WHERE "source_raw_s3_key" IS NOT NULL AND "redacted_at" IS NULL',
  definitionBody:
    "ON public.case_law_decisions USING btree (source_id, parser_version, parsed_input_state) WHERE ((source_raw_s3_key IS NOT NULL) AND (redacted_at IS NULL))",
  isUnique: false,
  name: "case_law_decisions_replay_pending_idx",
  tableName: "case_law_decisions",
} as const satisfies OnlineIndexDeclaration & {
  introducedBy: OnlineStepIntroduction;
};
