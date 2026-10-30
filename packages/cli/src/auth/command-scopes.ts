import { MCP_SCOPE_IMPLICATIONS } from "../generated/mcp-contract.js";
import type { CommandUnavailableCause } from "../unavailable-command.js";
import { decodeAccessTokenClaims } from "./jwt.js";
import { RESOURCE_SCOPE_PREFIX } from "./scopes.js";

const shellArgument = (value: string): string =>
  /^[A-Za-z0-9_.,:/=-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;

export const scopeGranted = ({
  token,
  scope,
}: {
  token: string;
  scope: string;
}): boolean => scopePreflightFailure({ token, scope }) === undefined;

type ScopePreflightFailureArgs = {
  additionalScopes?: readonly string[] | undefined;
  scope?: string | undefined;
  token: string;
  grantedScopes?: readonly string[] | undefined;
  serverUrl?: string | undefined;
};

export const scopePreflightFailure = ({
  additionalScopes,
  scope,
  token,
  grantedScopes: serverGrantedScopes,
  serverUrl,
}: ScopePreflightFailureArgs):
  Extract<CommandUnavailableCause, { type: "missing-scope" }> | undefined => {
  const claims = decodeAccessTokenClaims(token);
  const grantedScopes =
    serverGrantedScopes ??
    claims?.scope?.split(/\s+/u).filter((grant) => grant.length > 0);
  if (grantedScopes === undefined) {
    return undefined;
  }

  const requiredScopes: string[] = [];
  if (scope !== undefined) {
    requiredScopes.push(scope);
  }
  if (additionalScopes !== undefined) {
    requiredScopes.push(...additionalScopes);
  }

  const grantedScopeSet = new Set(grantedScopes);
  const missingScope = requiredScopes.find(
    (requiredScope) =>
      !grantedScopeSet.has(`${RESOURCE_SCOPE_PREFIX}${requiredScope}`) &&
      !MCP_SCOPE_IMPLICATIONS.some(
        ({ grant, scope: impliedScope }) =>
          impliedScope === `${RESOURCE_SCOPE_PREFIX}${requiredScope}` &&
          grantedScopeSet.has(grant),
      ),
  );
  if (missingScope === undefined) {
    return undefined;
  }

  // `--scopes` takes resource scopes only (the CLI always requests the
  // identity set itself), so the hint must not echo granted identity scopes
  // back: a command that `parseScopesFlag` rejects is a hint that loses the
  // user their refresh token.
  const requestedScopes = [
    ...new Set([
      ...grantedScopes.filter((grantedScope) =>
        grantedScope.startsWith(RESOURCE_SCOPE_PREFIX),
      ),
      ...requiredScopes.map(
        (requiredScope) => `${RESOURCE_SCOPE_PREFIX}${requiredScope}`,
      ),
    ]),
  ];
  return {
    type: "missing-scope",
    loginCommand: `stella auth login --scopes ${shellArgument(requestedScopes.join(","))}${serverUrl === undefined ? "" : ` --server ${shellArgument(serverUrl)}`}`,
    scope: `${RESOURCE_SCOPE_PREFIX}${missingScope}`,
  };
};
