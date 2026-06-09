ALTER TABLE "templates" ADD COLUMN "tags" text[];
--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "when_to_use" text;
--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "when_not_to_use" text;
--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "use_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "last_used_at" timestamp;
