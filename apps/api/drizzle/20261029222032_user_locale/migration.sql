SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The constant default uses PostgreSQL's fast-default catalog path; old
-- accounts read English without a row rewrite. The 1s lock bound avoids
-- queueing account writes behind this catalog change.
ALTER TABLE "user"
  ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint

-- Enforced on new writes now; the online migration phase validates old rows
-- after the schema transaction releases its table lock.
ALTER TABLE "user"
  ADD CONSTRAINT "user_locale_supported_check" CHECK (
    "locale" IN ('en', 'ar', 'cs', 'de', 'es', 'et', 'fr', 'hu', 'lt', 'lv', 'pl', 'pt-BR', 'sk')
  ) NOT VALID;--> statement-breakpoint

GRANT SELECT (locale) ON TABLE "user" TO stella;
