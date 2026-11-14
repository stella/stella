SET lock_timeout = '5s';
SET statement_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "reader_answer_language" text;
--> statement-breakpoint
GRANT SELECT (reader_answer_language) ON TABLE "user" TO stella;
