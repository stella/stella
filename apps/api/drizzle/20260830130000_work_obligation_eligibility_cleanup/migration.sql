SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed delete-data - governed work only ever belongs to an actionable row. Obligations attached to a fact, issue, requirement or event list row were created by a dark-launched path (both feature flags default off) that now refuses them, so these rows are unreachable state rather than user data, and their derived history goes with them through the ON DELETE CASCADE from work_obligation_events. Rollback: none needed; the bounded backfill sweep recreates an obligation for any entity that is eligible again.
DELETE FROM "work_obligations" WHERE "entity_id" IN (SELECT "id" FROM "entities" WHERE "list_item_type" IS NOT NULL AND "list_item_type" <> 'task');
