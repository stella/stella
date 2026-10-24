-- requires: 20261014130000_import_provenance
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Constraint validation is owned by the gated post-deploy online phase in
-- import-provenance-constraint-validation.ts; this retains migration ordering.
SELECT 1;
