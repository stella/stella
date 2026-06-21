CREATE TABLE "agent_registration" (
	"id" text PRIMARY KEY,
	"registration_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_code" text,
	"claim_token_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_sink" text NOT NULL,
	"login_hint" text,
	"bound_user_id" text,
	"bound_organization_id" text,
	"granted_scopes" text[] DEFAULT '{}' NOT NULL,
	"authorization_code" text,
	"poll_interval_seconds" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_polled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_registration_claim_token_hash_uidx" ON "agent_registration" ("claim_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_registration_pending_user_code_uidx" ON "agent_registration" ("user_code") WHERE status = 'pending' AND user_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_registration_status_idx" ON "agent_registration" ("status");--> statement-breakpoint
CREATE INDEX "agent_registration_bound_user_id_idx" ON "agent_registration" ("bound_user_id");--> statement-breakpoint

-- Control-plane auth data: same trust tier as oauth_client. The scoped
-- `stella` role gets no grants and a deny-all RLS policy, so it can never
-- read hashed claim tokens or stored authorization codes. All access is
-- via the table-owner connection (rootDb).
ALTER TABLE "agent_registration" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "agent_registration" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "agent_registration" FROM stella;
