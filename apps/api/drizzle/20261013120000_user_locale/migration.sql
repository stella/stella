SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "user"
  ADD COLUMN "locale" text DEFAULT 'en' NOT NULL,
  ADD CONSTRAINT "user_locale_supported_check" CHECK (
    "locale" IN ('en', 'ar', 'cs', 'de', 'es', 'et', 'fr', 'hu', 'lt', 'lv', 'pl', 'pt-BR', 'sk')
  );--> statement-breakpoint
GRANT SELECT (locale) ON TABLE "user" TO stella;
