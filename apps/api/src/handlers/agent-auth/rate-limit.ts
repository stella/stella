// Canonical matcher for the unauthenticated agent-auth endpoints, kept in
// sync with the `/agent/...` paths in @/api/agent-auth/constants. The shared
// `/v1` rate limiter never sees these (they mount at root), but index.ts uses
// this so the agent-auth endpoints count only against their dedicated
// `agentAuth` budget. The session-authed confirm endpoint is intentionally
// excluded: it runs under the normal auth macro, not this bucket.
const AGENT_AUTH_RATE_LIMIT_PATH_RE =
  /^\/agent\/(?:identity(?:\/claim)?|token|event\/notify)$/u;

export const isAgentAuthRateLimitedPath = (pathname: string) =>
  AGENT_AUTH_RATE_LIMIT_PATH_RE.test(pathname);
