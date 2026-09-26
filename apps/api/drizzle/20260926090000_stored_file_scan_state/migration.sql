SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Whether a stored template or style-set file passed the upload scan when it
-- was written. The rows that exist now carry no such record, so they start
-- `unscanned`: their next read scans the bytes and marks the row `scanned`.
-- Writers record `scanned` themselves; the default keeps any row without that
-- record on the scanning path. A constant default is a catalog-only change,
-- so no table is rewritten. The value list is STORED_FILE_SCAN_STATES.

ALTER TABLE "templates"
  ADD COLUMN "scan_state" text NOT NULL DEFAULT 'unscanned';
--> statement-breakpoint

ALTER TABLE "template_versions"
  ADD COLUMN "scan_state" text NOT NULL DEFAULT 'unscanned';
--> statement-breakpoint

ALTER TABLE "style_sets"
  ADD COLUMN "scan_state" text NOT NULL DEFAULT 'unscanned';
--> statement-breakpoint

ALTER TABLE "templates"
  ADD CONSTRAINT "templates_scan_state_check"
  CHECK ("scan_state" IN ('scanned', 'unscanned')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "template_versions"
  ADD CONSTRAINT "template_versions_scan_state_check"
  CHECK ("scan_state" IN ('scanned', 'unscanned')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "style_sets"
  ADD CONSTRAINT "style_sets_scan_state_check"
  CHECK ("scan_state" IN ('scanned', 'unscanned')) NOT VALID;
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- added NOT VALID above; the validating scan reads the templates table, bounded by the per-organization template limit
ALTER TABLE "templates" VALIDATE CONSTRAINT "templates_scan_state_check";
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- added NOT VALID above; the validating scan reads template versions, bounded by the per-template version limit
ALTER TABLE "template_versions" VALIDATE CONSTRAINT "template_versions_scan_state_check";
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- added NOT VALID above; the validating scan reads the style sets table, bounded by the per-organization style set limit
ALTER TABLE "style_sets" VALIDATE CONSTRAINT "style_sets_scan_state_check";
