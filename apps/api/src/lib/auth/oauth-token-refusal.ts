import { panic } from "better-result";

import { sha256Hex } from "@stll/sha256/bun";

import { isRecord } from "@/api/lib/type-guards";

/** Shared with the pinned provider patch; the value stays on request context. */
export const OAUTH_TOKEN_OBSERVATION = Symbol.for("stella.oauth.token-refusal");

export const OAUTH_TOKEN_REFUSAL_REASONS = [
  "expired",
  "rotated_outside_replay",
  "revoked",
  "unknown_token",
  "client_mismatch",
  "resource_mismatch",
  "scope_mismatch",
  "code_invalid",
  "code_malformed",
  "redirect_mismatch",
  "pkce_mismatch",
  "dpop_mismatch",
  "rotation_conflict",
  "rotation_replay_mismatch",
  "request_invalid",
  "client_authentication_failed",
  "client_not_allowed",
  "user_unavailable",
  "session_unavailable",
  "unsupported_grant",
  "rate_limited",
  "server_configuration",
  "unclassified",
] as const;

export type OAuthTokenRefusalReason =
  (typeof OAUTH_TOKEN_REFUSAL_REASONS)[number];

const isRefusalReason = (value: unknown): value is OAuthTokenRefusalReason =>
  OAUTH_TOKEN_REFUSAL_REASONS.some((reason) => reason === value);

/** Shared provider validators refuse by protocol code, before/after grant lookup. */
export const OAUTH_PROTOCOL_REFUSAL_REASONS = {
  invalid_request: "request_invalid",
  invalid_client: "client_authentication_failed",
  unauthorized_client: "client_not_allowed",
  invalid_target: "resource_mismatch",
  invalid_scope: "scope_mismatch",
  invalid_token: "unknown_token",
  invalid_user: "user_unavailable",
  invalid_dpop_proof: "dpop_mismatch",
  unsupported_grant_type: "unsupported_grant",
  validation_error: "request_invalid",
  too_many_requests: "rate_limited",
} as const satisfies Record<string, OAuthTokenRefusalReason>;

const refusalReason = (
  errorCode: string,
  observedReason: unknown,
): OAuthTokenRefusalReason => {
  if (isRefusalReason(observedReason)) {
    return observedReason;
  }
  if (observedReason !== undefined) {
    return "unclassified";
  }
  for (const [code, reason] of Object.entries(OAUTH_PROTOCOL_REFUSAL_REASONS)) {
    if (code === errorCode) {
      return reason;
    }
  }
  // Explicitly queryable; a provider change never silently becomes "other".
  return "unclassified";
};

type DescribeOAuthTokenRefusalOptions = {
  observation: unknown;
  body: unknown;
  errorCode: string;
};

export const describeOAuthTokenRefusal = ({
  observation,
  body,
  errorCode,
}: DescribeOAuthTokenRefusalOptions) => {
  const observed = isRecord(observation) ? observation : undefined;
  const reason = refusalReason(errorCode, observed?.["reason"]);
  const requestedClientId = isRecord(body) ? body["client_id"] : undefined;
  const clientId = observed?.["clientId"] ?? requestedClientId;
  const familyId = observed?.["familyId"];
  const attributes = {
    "oauth.refusal_reason": reason,
    "oauth.client_id": typeof clientId === "string" ? clientId : null,
    // The provider stores a high-entropy authorization-code identifier and
    // carries it into every rotated refresh row. Hash that identifier with a
    // domain separator; never hash a refresh row id or a submitted credential.
    "oauth.grant_family":
      typeof familyId === "string"
        ? sha256Hex(`stella:oauth:grant-family:v1:${familyId}`)
        : null,
  };
  switch (reason) {
    case "expired":
    case "rotated_outside_replay":
    case "revoked":
    case "unknown_token":
    case "client_mismatch":
    case "resource_mismatch":
    case "scope_mismatch":
    case "code_invalid":
    case "code_malformed":
    case "redirect_mismatch":
    case "pkce_mismatch":
    case "dpop_mismatch":
    case "rotation_conflict":
    case "rotation_replay_mismatch":
    case "request_invalid":
    case "client_authentication_failed":
    case "client_not_allowed":
    case "user_unavailable":
    case "session_unavailable":
    case "unsupported_grant":
    case "rate_limited":
    case "server_configuration":
      return attributes;
    case "unclassified":
      return { ...attributes, "oauth.refusal_unclassified": true };
    default:
      reason satisfies never;
      return panic("Unknown OAuth token refusal reason");
  }
};
