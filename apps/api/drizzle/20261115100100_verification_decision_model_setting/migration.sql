SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Whether an organization's Anchor Verification asks the decision model for
-- each claim's verdict. Off by default, so every organization keeps the
-- language model's verdicts until an administrator turns it on. A constant
-- default rewrites no rows.
ALTER TABLE "organization_settings" ADD COLUMN "verification_decision_model_enabled" boolean DEFAULT false NOT NULL;
