CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "message" text NOT NULL,
  "is_read" boolean DEFAULT false NOT NULL,
  "read_at" timestamp with time zone,
  "entity_type" text,
  "entity_id" text,
  "idempotency_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notifications_idempotency_key_unique" UNIQUE("idempotency_key")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "notifications_user_id_idx" ON "notifications" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_id_created_at_idx" ON "notifications" ("user_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_id_is_read_idx" ON "notifications" ("user_id", "is_read");--> statement-breakpoint

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "user_select" ON "notifications"
  AS PERMISSIVE FOR SELECT TO "stella"
  USING (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint

CREATE POLICY "user_insert" ON "notifications"
  AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint

CREATE POLICY "user_update" ON "notifications"
  AS PERMISSIVE FOR UPDATE TO "stella"
  USING (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint

CREATE POLICY "user_delete" ON "notifications"
  AS PERMISSIVE FOR DELETE TO "stella"
  USING (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "notifications" TO stella;
