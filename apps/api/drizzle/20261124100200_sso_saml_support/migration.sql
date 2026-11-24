SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Allow either OIDC or SAML 2.0 configuration on `sso_provider` (never both,
-- never neither). Existing OIDC rows already satisfy the new constraint.
-- stella-migration-safety: reviewed drop-constraint - replaces narrow OIDC-only check with OIDC-XOR-SAML check in the same transaction
ALTER TABLE "sso_provider" DROP CONSTRAINT "sso_provider_oidc_only_check";--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_single_protocol_check" CHECK (
  ("oidc_config" IS NOT NULL AND "saml_config" IS NULL)
  OR ("oidc_config" IS NULL AND "saml_config" IS NOT NULL)
) NOT VALID;
