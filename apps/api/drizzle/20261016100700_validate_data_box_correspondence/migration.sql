-- requires: 20261016100600_data_box_correspondence
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';
-- The registered online constraint repairs validate through the contention
-- gate after the schema transaction commits; no table scan runs here.
