-- requires: 20261029074200_data_box_sources
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';
-- The registered online constraint repairs validate through the contention
-- gate after the schema transaction commits; no table scan runs here.
