import { TaggedError } from "better-result";

export class McpAuthenticationError extends TaggedError(
  "McpAuthenticationError",
)<{
  message: string;
  cause?: unknown;
}>() {}

export class McpOrganizationAccessError extends TaggedError(
  "McpOrganizationAccessError",
)<{
  message: string;
}>() {}

/**
 * An infrastructure failure while verifying the bearer token (JWKS fetch/network
 * outage, JWKS timeout, or any non-rejection fault) rather than a genuine bad or
 * expired token. Distinct from `McpAuthenticationError` so the transport can
 * surface it as a captured, retryable 5xx instead of a 401: a JWKS outage must
 * not present to clients as "invalid token" (which triggers pointless re-consent
 * and hides the outage from telemetry).
 */
export class McpTokenVerificationError extends TaggedError(
  "McpTokenVerificationError",
)<{
  message: string;
  cause?: unknown;
}>() {}

/**
 * A backing store read failed while loading the dynamic gateway surface
 * (external connector tools or agent skills). Distinct from an empty result so
 * dispatch answers a transient DB outage with a retryable `internal_error`
 * instead of a non-retryable `unknown_tool`, and `tools/list` fails loudly
 * instead of silently shrinking. The underlying failure is captured at the load
 * site; this error only carries the fact that the load failed.
 */
export class McpGatewayLoadError extends TaggedError("McpGatewayLoadError")<{
  message: string;
  cause?: unknown;
}>() {}
