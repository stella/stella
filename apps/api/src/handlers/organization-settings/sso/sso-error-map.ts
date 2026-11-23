import { panic } from "better-result";

import { classifyFailure } from "@stll/errors";

import type { SamlMetadataError } from "@/api/lib/auth/saml-metadata";
import type { OidcDiscoveryError } from "@/api/lib/auth/sso-discovery";
import type { SsoDomainDnsError } from "@/api/lib/auth/sso-domain-verify";
import type { SsoManagementError } from "@/api/lib/db/sso-management";
import type { SsoProvisioningError } from "@/api/lib/db/sso-provisioning";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const mapSsoManagementError = (
  error: SsoManagementError,
): HandlerError => {
  switch (error.reason) {
    case "invalid_config":
    case "last_provider_while_required":
    case "provider_required_to_enforce":
      return new HandlerError({
        status: 400,
        code: error.reason,
        message: error.message,
      });
    case "provider_not_found":
    case "domain_not_found":
      return new HandlerError({
        status: 404,
        code: error.reason,
        message: error.message,
      });
    case "domain_already_exists":
    case "domain_verified_elsewhere":
      return new HandlerError({
        status: 409,
        code: error.reason,
        message: error.message,
      });
    default:
      error.reason satisfies never;
      return panic("Unhandled SSO management error reason");
  }
};

export const mapOidcDiscoveryError = (
  error: OidcDiscoveryError,
): HandlerError => {
  switch (error.reason) {
    case "invalid_url":
    case "invalid_document":
    case "issuer_mismatch":
      return new HandlerError({
        status: 400,
        code: `sso_oidc_${error.reason}`,
        message: error.message,
      });
    case "fetch_failed":
      return classifyFailure(
        new HandlerError({
          status: 502,
          code: "sso_oidc_fetch_failed",
          message: error.message,
        }),
        "upstream_unavailable",
      );
    default:
      error.reason satisfies never;
      return panic("Unhandled OIDC discovery error reason");
  }
};

export const mapSsoDomainDnsError = (error: SsoDomainDnsError): HandlerError =>
  classifyFailure(
    new HandlerError({
      status: 502,
      code: "sso_domain_dns_failed",
      message: error.message,
    }),
    "upstream_unavailable",
  );

export const mapSamlMetadataError = (
  error: SamlMetadataError,
): HandlerError => {
  switch (error.reason) {
    case "invalid_url":
    case "invalid_document":
      return new HandlerError({
        status: 400,
        code: `sso_saml_metadata_${error.reason}`,
        message: error.message,
      });
    case "fetch_failed":
      return classifyFailure(
        new HandlerError({
          status: 502,
          code: "sso_saml_metadata_fetch_failed",
          message: error.message,
        }),
        "upstream_unavailable",
      );
    default:
      error.reason satisfies never;
      return panic("Unhandled SAML metadata error reason");
  }
};

export const mapSsoProvisioningError = (
  error: SsoProvisioningError,
): HandlerError => {
  switch (error.reason) {
    case "pending_not_found":
      return new HandlerError({
        status: 404,
        code: error.reason,
        message: error.message,
      });
    case "seat_limit_reached":
    case "already_reviewed":
      return new HandlerError({
        status: 409,
        code: error.reason,
        message: error.message,
      });
    default:
      error.reason satisfies never;
      return panic("Unhandled SSO provisioning error reason");
  }
};
