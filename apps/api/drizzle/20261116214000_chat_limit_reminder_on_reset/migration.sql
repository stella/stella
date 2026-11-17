SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- A member can ask that their chat continue by itself when the usage limit
-- that stopped its turn on their computer resets, instead of only hearing
-- about it. Additive: one column whose constant default rewrites no rows,
-- so every existing reminder stays a notification, and a NOT VALID check of
-- its values, validated online. Old API tasks never read the column.
ALTER TABLE "chat_limit_reminders" ADD COLUMN "on_reset" text DEFAULT 'notify' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_limit_reminders" ADD CONSTRAINT "chat_limit_reminders_on_reset_check"
  CHECK ("on_reset" IN ('notify', 'continue')) NOT VALID;
