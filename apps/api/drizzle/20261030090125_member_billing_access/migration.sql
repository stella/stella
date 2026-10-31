SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A constant default gives existing memberships no additional grant without a row rewrite.
ALTER TABLE "member" ADD COLUMN "billing_access" boolean DEFAULT false NOT NULL;
