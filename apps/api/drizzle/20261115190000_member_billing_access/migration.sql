SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A constant default gives existing memberships no additional grant without a row rewrite.
ALTER TABLE "member" ADD COLUMN "billing_access" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- Owners and admins set this through the application role: it may update
-- this column, beside the member's own navigation state, on memberships of
-- the active organization (policy auth_member_update_last_active_workspace).
-- The writer rechecks the actor's authority under the row locks.
GRANT UPDATE (billing_access) ON TABLE "member" TO stella;
