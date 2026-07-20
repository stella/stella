SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"prefix" text,
	"key" text NOT NULL,
	"reference_id" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer DEFAULT 0 NOT NULL,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
-- `reference_id` holds a user id (the plugin runs with `references: "user"`), so
-- deleting a user must take their machine keys with it. Enforcing revocation in
-- the FK removes the possibility of a live credential pointing at a principal
-- that no longer exists.
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_reference_id_user_id_fk" FOREIGN KEY ("reference_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
-- `key` stores a SHA-256 digest that the verification path resolves a credential
-- by; two rows sharing one digest is corruption, so the database refuses it.
CREATE UNIQUE INDEX "apikey_key_uidx" ON "apikey" ("key");--> statement-breakpoint
CREATE INDEX "apikey_reference_id_idx" ON "apikey" ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_config_id_idx" ON "apikey" ("config_id");--> statement-breakpoint

-- Control-plane auth data, same trust tier as jwks and oauth_client: the row
-- holds a credential digest plus the permission set that credential carries.
-- The scoped `stella` role gets no grants and a deny-all RLS policy, so a
-- tenant-scoped connection can neither read digests nor widen a key's
-- permissions. All access is via the table-owner connection (rootDb) through
-- better-auth.
ALTER TABLE "apikey" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "apikey" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "apikey" FROM stella;
