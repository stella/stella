import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { TestOidcSsoProviderResponse } from "@stll/api-contract/sso";
import { declareFingerprintFields } from "@stll/errors";

import { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";

const trimTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
};

const OIDC_DISCOVERY_TIMEOUT_MS = 8000;
const OIDC_DISCOVERY_MAX_BYTES = 256 * 1024;
const OIDC_WELL_KNOWN_SUFFIX = "/.well-known/openid-configuration";

export class OidcDiscoveryError extends TaggedError("oidc_discovery_error")<{
  message: string;
  reason:
    "invalid_url" | "fetch_failed" | "invalid_document" | "issuer_mismatch";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const discoveryDocumentSchema = v.looseObject({
  issuer: v.pipe(v.string(), v.trim(), v.minLength(1)),
  authorization_endpoint: v.pipe(v.string(), v.trim(), v.url()),
  token_endpoint: v.pipe(v.string(), v.trim(), v.url()),
  jwks_uri: v.pipe(v.string(), v.trim(), v.url()),
});

const normalizeIssuer = (value: string): string =>
  trimTrailingSlashes(value.trim());

export const deriveDiscoveryEndpoint = (
  issuer: string,
  explicitDiscoveryEndpoint?: string,
): Result<string, OidcDiscoveryError> => {
  const candidate =
    explicitDiscoveryEndpoint !== undefined &&
    explicitDiscoveryEndpoint.trim() !== ""
      ? explicitDiscoveryEndpoint.trim()
      : `${normalizeIssuer(issuer)}${OIDC_WELL_KNOWN_SUFFIX}`;

  const parsed = Result.try({
    try: () => new URL(candidate),
    catch: () =>
      new OidcDiscoveryError({
        message: "OIDC discovery URL is not valid",
        reason: "invalid_url",
      }),
  });
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  if (parsed.value.protocol !== "https:") {
    return Result.err(
      new OidcDiscoveryError({
        message: "OIDC issuer and discovery URLs must use HTTPS",
        reason: "invalid_url",
      }),
    );
  }
  return Result.ok(parsed.value.toString());
};

type ProbeOidcDiscoveryOptions = {
  issuer: string;
  discoveryEndpoint?: string;
  permit: ThirdPartyOutboundPermit;
  fetchBytes?: typeof safeOutboundFetchBytes;
};

/**
 * Fetches and validates an OIDC discovery document through the SSRF-checked
 * outbound fetch pipeline. Verifies the returned `issuer` matches the
 * configured issuer and that authorization, token, and JWKS endpoints exist.
 */
export const probeOidcDiscovery = async ({
  issuer,
  discoveryEndpoint,
  permit,
  fetchBytes = safeOutboundFetchBytes,
}: ProbeOidcDiscoveryOptions): Promise<
  Result<TestOidcSsoProviderResponse, OidcDiscoveryError>
> => {
  const issuerParsed = Result.try({
    try: () => new URL(issuer),
    catch: () =>
      new OidcDiscoveryError({
        message: "OIDC issuer URL is not valid",
        reason: "invalid_url",
      }),
  });
  if (issuerParsed.isErr() || issuerParsed.value.protocol !== "https:") {
    return Result.err(
      new OidcDiscoveryError({
        message: "OIDC issuer URL must use HTTPS",
        reason: "invalid_url",
      }),
    );
  }

  const endpointResult = deriveDiscoveryEndpoint(issuer, discoveryEndpoint);
  if (endpointResult.isErr()) {
    return Result.err(endpointResult.error);
  }

  const response = await fetchBytes({
    url: endpointResult.value,
    permit,
    maxBytes: OIDC_DISCOVERY_MAX_BYTES,
    timeout: { type: "headers", ms: OIDC_DISCOVERY_TIMEOUT_MS },
    headers: { accept: "application/json" },
  });
  if (response.isErr()) {
    return Result.err(
      new OidcDiscoveryError({
        message: "Could not fetch the OIDC discovery document",
        reason: "fetch_failed",
      }),
    );
  }
  if (response.value.status < 200 || response.value.status >= 300) {
    return Result.err(
      new OidcDiscoveryError({
        message: `OIDC discovery endpoint returned HTTP ${response.value.status}`,
        reason: "fetch_failed",
      }),
    );
  }

  const decoded = Result.try({
    try: (): unknown =>
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(response.value.body),
      ),
    catch: () =>
      new OidcDiscoveryError({
        message: "OIDC discovery response is not valid JSON",
        reason: "invalid_document",
      }),
  });
  if (decoded.isErr()) {
    return Result.err(decoded.error);
  }

  const parsed = v.safeParse(discoveryDocumentSchema, decoded.value);
  if (!parsed.success) {
    return Result.err(
      new OidcDiscoveryError({
        message:
          "OIDC discovery document is missing required endpoints (issuer, authorization_endpoint, token_endpoint, jwks_uri)",
        reason: "invalid_document",
      }),
    );
  }

  if (normalizeIssuer(parsed.output.issuer) !== normalizeIssuer(issuer)) {
    return Result.err(
      new OidcDiscoveryError({
        message:
          "Discovery document issuer does not match the configured issuer",
        reason: "issuer_mismatch",
      }),
    );
  }

  return Result.ok({
    issuer: parsed.output.issuer,
    discoveryEndpoint: endpointResult.value,
    authorizationEndpoint: parsed.output.authorization_endpoint,
    tokenEndpoint: parsed.output.token_endpoint,
    jwksUri: parsed.output.jwks_uri,
  });
};
