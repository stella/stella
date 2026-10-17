// The expand half of removing a table or column. A release stops declaring it
// in schema.ts and its migration marks it, while the database keeps it, so the
// release before can still be rolled back to:
//
//   COMMENT ON COLUMN "table"."column" IS 'stella:retired';
//   COMMENT ON TABLE "table" IS 'stella:retired - <optional note>';
//
// The contract half (DROP) belongs to a later release, once the marking
// release is promoted. scripts/check-migrated-schema-parity.ts accepts exactly the
// drops a marker explains; scripts/check-migration-safety.ts and
// scripts/migration-rollback-compatibility.ts treat a marked object as
// unused by every release from the marking one on.
export const RETIRED_SCHEMA_COMMENT = "stella:retired";

const RETIRED_SCHEMA_COMMENT_PATTERN = new RegExp(
  `^${RETIRED_SCHEMA_COMMENT}(?:\\s|$)`,
  "u",
);

export const isRetiredSchemaComment = (comment: string | null): boolean =>
  comment !== null && RETIRED_SCHEMA_COMMENT_PATTERN.test(comment);
