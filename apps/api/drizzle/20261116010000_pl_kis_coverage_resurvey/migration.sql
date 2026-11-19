SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
-- The Polish tax-information source now lists ten more document kinds, and
-- each issue month gains a slice per kind. The historical sweep fills down
-- from the oldest slice its ledger holds and never revisits a month above
-- it, so the new kinds' months already passed would stay unlisted. Clearing
-- the source's ledger has the sweep survey every month once more, from the
-- tip down, and collect the new kinds' history; decisions already stored and
-- their listing revisions stay, so unchanged records are not written again.
-- stella-migration-safety: reviewed delete-data - the coverage ledger only records which publisher slices were surveyed; the sweep rebuilds it from the publisher, and rollback needs no restore
DELETE FROM "case_law_coverage_slices"
WHERE "source_id" IN (
  SELECT "id" FROM "case_law_sources" WHERE "adapter_key" = 'pl-kis'
);
