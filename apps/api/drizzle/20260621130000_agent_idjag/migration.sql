ALTER TABLE "agent_registration" ADD COLUMN "pending_delegation_iss" text;--> statement-breakpoint
ALTER TABLE "agent_registration" ADD COLUMN "pending_delegation_sub" text;--> statement-breakpoint
CREATE TABLE "agent_trusted_issuer" (
	"issuer" text PRIMARY KEY,
	"display_name" text NOT NULL,
	"attestation_policy" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_delegation" (
	"id" text PRIMARY KEY,
	"iss" text NOT NULL,
	"sub" text NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_assertion_replay" (
	"jti" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_delegation_iss_sub_uidx" ON "agent_delegation" ("iss","sub");--> statement-breakpoint
CREATE INDEX "agent_delegation_user_id_idx" ON "agent_delegation" ("user_id");--> statement-breakpoint
CREATE INDEX "agent_assertion_replay_expires_at_idx" ON "agent_assertion_replay" ("expires_at");--> statement-breakpoint

-- Control-plane auth data: same trust tier as oauth_client / agent_registration.
-- The scoped `stella` role gets no grants and a deny-all RLS policy on every
-- table, so it can never read the trusted-issuer allow-list, the (iss,sub)
-- delegations, or the replay store. All access is via the table-owner
-- connection (rootDb).
ALTER TABLE "agent_trusted_issuer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "agent_trusted_issuer" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "agent_trusted_issuer" FROM stella;--> statement-breakpoint

ALTER TABLE "agent_delegation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "agent_delegation" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "agent_delegation" FROM stella;--> statement-breakpoint

ALTER TABLE "agent_assertion_replay" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "agent_assertion_replay" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "agent_assertion_replay" FROM stella;
