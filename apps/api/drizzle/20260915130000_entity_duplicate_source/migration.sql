SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A nullable provenance marker makes caller-selected duplicate identities
-- replay-safe without rewriting existing rows.
ALTER TABLE "entities" ADD COLUMN "duplicate_source_entity_id" uuid;
