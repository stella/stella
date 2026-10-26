SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
-- stella-migration-safety: reviewed delete-data - Better Auth trust-device
-- verification rows are ephemeral bypass grants. The application no longer
-- accepts or issues them because version 1.7.6 does not bind them to an MFA
-- enrollment generation; users can complete the normal second-factor prompt.
DELETE FROM "verification"
WHERE "identifier" LIKE 'trust-device-%';
