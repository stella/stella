SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The key ranges a route's census pass is split into, each walked by its own
-- cursor: one JSON object bound to the pass it belongs to (`passId`), with
-- one element per range. Written only by the route proof store, which
-- parses it strictly; null until the pass's first page lays the ranges out.
-- A range set bound to another pass id is void, so a writer that starts a
-- new pass without clearing it still never resumes an older pass's ranges.
-- Nullable with no default, so adding it rewrites no stored row.
ALTER TABLE "corpus_index_route_proofs" ADD COLUMN "pass_ranges" jsonb;
