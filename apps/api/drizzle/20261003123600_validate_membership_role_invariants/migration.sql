-- requires: 20261003123500_membership_role_invariants
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Commit the prerequisite and its migration receipt before validation.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "member" VALIDATE CONSTRAINT "member_single_product_role";--> statement-breakpoint
ALTER TABLE "invitation" VALIDATE CONSTRAINT "invitation_single_product_role";
