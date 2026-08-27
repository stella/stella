SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Align the legacy two-factor table with the denied auth-table access
-- boundary. Better Auth uses the owner connection; scoped application reads
-- were already rejected by the table's deny policy.
REVOKE ALL PRIVILEGES ON TABLE "two_factor" FROM stella;
