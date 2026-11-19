SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Null means the user has not picked a language, so the browser's language
-- applies. A nullable column without a default is a catalog-only change; the
-- 1s lock bound avoids queueing account writes behind it.
ALTER TABLE "user"
  ADD COLUMN "locale" text;--> statement-breakpoint

-- Enforced on new writes now; the online migration phase validates old rows
-- after the schema transaction releases its table lock.
ALTER TABLE "user"
  ADD CONSTRAINT "user_locale_supported_check" CHECK (
    "locale" IN ('en', 'ar', 'cs', 'de', 'es', 'et', 'fr', 'hu', 'lt', 'lv', 'pl', 'pt-BR', 'sk')
  ) NOT VALID;--> statement-breakpoint

GRANT SELECT (locale) ON TABLE "user" TO stella;
