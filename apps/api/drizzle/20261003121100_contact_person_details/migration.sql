SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

ALTER TABLE "contacts" ADD COLUMN "date_of_birth_year" integer;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "date_of_birth_month" integer;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "date_of_birth_day" integer;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "nationality_codes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint

ALTER TABLE "contacts" ADD CONSTRAINT "contacts_person_details_check" CHECK (
  "type" = 'person' OR ("date_of_birth_year" IS NULL AND "date_of_birth_month" IS NULL AND "date_of_birth_day" IS NULL AND cardinality("nationality_codes") = 0)
) NOT VALID;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_date_of_birth_check" CHECK (
  ("date_of_birth_year" IS NULL AND "date_of_birth_month" IS NULL AND "date_of_birth_day" IS NULL)
  OR ("date_of_birth_year" IS NOT NULL AND "date_of_birth_year" BETWEEN 1000 AND 9999 AND (
    ("date_of_birth_month" IS NULL AND "date_of_birth_day" IS NULL)
    OR ("date_of_birth_month" IS NOT NULL AND "date_of_birth_month" BETWEEN 1 AND 12 AND (
      "date_of_birth_day" IS NULL OR "date_of_birth_day" BETWEEN 1 AND CASE
        WHEN "date_of_birth_month" = 2 THEN CASE WHEN mod("date_of_birth_year", 400) = 0 OR (mod("date_of_birth_year", 4) = 0 AND mod("date_of_birth_year", 100) <> 0) THEN 29 ELSE 28 END
        WHEN "date_of_birth_month" IN (4, 6, 9, 11) THEN 30 ELSE 31
      END
    ))
  ))
) NOT VALID;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_nationality_codes_check" CHECK (
  array_position("nationality_codes", NULL) IS NULL AND
  (cardinality("nationality_codes") = 0 OR (array_to_string("nationality_codes", ',') ~ '^([A-Z]{2})(,[A-Z]{2})*$' AND char_length(array_to_string("nationality_codes", '')) = 2 * cardinality("nationality_codes")))
) NOT VALID;--> statement-breakpoint
