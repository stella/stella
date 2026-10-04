-- requires: 20261003123100_case_law_document_outstanding_idx
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The online phase builds the date-led outstanding-document index
-- CONCURRENTLY after the bookkeeping transaction commits. It validates the
-- replacement before concurrently retiring document_pending_date_idx.
SELECT 1;
--> statement-breakpoint
