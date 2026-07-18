SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "two_factor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "two_factor" TO stella;--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "two_factor" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
GRANT SELECT (two_factor_enabled) ON TABLE "user" TO stella;
