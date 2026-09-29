SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Whether a stored template or style-set file passed the upload scan when it
-- was written. The rows that exist now carry no such record, so they start
-- `unscanned`: their next read scans the bytes and marks the row `scanned`.
-- Writers record `scanned` themselves; the default keeps any row without that
-- record on the scanning path. A constant default is a catalog-only change,
-- so no table is rewritten. The value list is STORED_FILE_SCAN_STATES.
-- Every statement can run again, so a retried deployment re-enters the same
-- state.

ALTER TABLE "templates"
  ADD COLUMN IF NOT EXISTS "scan_state" text NOT NULL DEFAULT 'unscanned';
--> statement-breakpoint

ALTER TABLE "template_versions"
  ADD COLUMN IF NOT EXISTS "scan_state" text NOT NULL DEFAULT 'unscanned';
--> statement-breakpoint

ALTER TABLE "style_sets"
  ADD COLUMN IF NOT EXISTS "scan_state" text NOT NULL DEFAULT 'unscanned';
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "templates"
  DROP CONSTRAINT IF EXISTS "templates_scan_state_check";--> statement-breakpoint
ALTER TABLE "templates"
  ADD CONSTRAINT "templates_scan_state_check"
  CHECK ("scan_state" IN ('scanned', 'unscanned')) NOT VALID;
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "template_versions"
  DROP CONSTRAINT IF EXISTS "template_versions_scan_state_check";--> statement-breakpoint
ALTER TABLE "template_versions"
  ADD CONSTRAINT "template_versions_scan_state_check"
  CHECK ("scan_state" IN ('scanned', 'unscanned')) NOT VALID;
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "style_sets"
  DROP CONSTRAINT IF EXISTS "style_sets_scan_state_check";--> statement-breakpoint
ALTER TABLE "style_sets"
  ADD CONSTRAINT "style_sets_scan_state_check"
  CHECK ("scan_state" IN ('scanned', 'unscanned')) NOT VALID;
