SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_monitoring_principal_check" CHECK (
  (id NOT LIKE 'synthetic-session-%' OR user_id = 'synthetic-prod-user')
  AND (id NOT LIKE 'smoke-session-%' OR user_id IN ('smoke-user-stella', 'smoke-ai-user-stella'))
) NOT VALID;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_monitoring_slug_check" CHECK (
  slug <> 'stella:monitoring:synthetic-prod-org' OR id = 'synthetic-prod-org'
) NOT VALID;--> statement-breakpoint
INSERT INTO "organization" (id, name, slug, created_at) VALUES (
  'synthetic-prod-org', 'Product Monitoring', 'stella:monitoring:synthetic-prod-org', '2026-10-19T07:00:00Z'::timestamptz
) ON CONFLICT ON CONSTRAINT organization_pkey DO NOTHING;--> statement-breakpoint
CREATE FUNCTION enforce_synthetic_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id = 'synthetic-prod-user' AND NEW.organization_id <> 'synthetic-prod-org' THEN
    RAISE EXCEPTION 'Monitoring membership requires its dedicated organization' USING ERRCODE = '23514', CONSTRAINT = 'member_synthetic_organization_check';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION enforce_synthetic_membership() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER member_synthetic_organization_check BEFORE INSERT OR UPDATE OF user_id, organization_id ON member FOR EACH ROW EXECUTE FUNCTION enforce_synthetic_membership();--> statement-breakpoint
CREATE TABLE "synthetic_session_control" (
  "id" text PRIMARY KEY NOT NULL,
  "status" text NOT NULL DEFAULT 'enabled',
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "synthetic_session_control_id_check" CHECK (id = 'monitoring-session'),
  CONSTRAINT "synthetic_session_control_status_check" CHECK (status IN ('enabled', 'revoked'))
);--> statement-breakpoint
ALTER TABLE "synthetic_session_control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "synthetic_session_control" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "synthetic_session_control_owner" ON "synthetic_session_control" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.synthetic_session_control'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.synthetic_session_control'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "synthetic_session_control" FOR ALL TO stella USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "synthetic_session_control" FROM stella;--> statement-breakpoint
INSERT INTO "synthetic_session_control" (id) VALUES ('monitoring-session');
