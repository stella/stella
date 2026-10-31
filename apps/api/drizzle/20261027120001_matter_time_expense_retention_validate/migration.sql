SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
-- Retain this migration identity. The registered online phase validates all
-- four retention constraints through the table gate after deployment.
