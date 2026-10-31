import { panic } from "better-result";

import { MCP_SCOPE_IMPLICATIONS } from "../generated/mcp-contract.js";
import type { CurrentRegistry } from "../registry-refresh.js";
import type { CommandUnavailableCause } from "../unavailable-command.js";
import { decodeAccessTokenClaims } from "./jwt.js";
import { RESOURCE_SCOPE_PREFIX } from "./scopes.js";

/** One invocation's authoritative grants, shared by discovery and execution. */
export type EffectiveGrants =
  | { readonly type: "known"; readonly scopes: readonly string[] }
  | { readonly type: "unknown" };

type ResolveEffectiveGrantsOptions = {
  token?: string | undefined;
  registry?: Pick<CurrentRegistry, "grantedScopes"> | undefined;
};

export const resolveEffectiveGrants = ({
  token,
  registry,
}: ResolveEffectiveGrantsOptions): EffectiveGrants => {
  const serverGrantedScopes = registry?.grantedScopes;
  if (serverGrantedScopes !== undefined) {
    return { type: "known", scopes: serverGrantedScopes };
  }
  const scope =
    token === undefined ? undefined : decodeAccessTokenClaims(token)?.scope;
  return scope === undefined
    ? { type: "unknown" }
    : {
        type: "known",
        scopes: scope.split(/\s+/u).filter((grant) => grant.length > 0),
      };
};

const shellArgument = (value: string): string =>
  /^[A-Za-z0-9_.,:/=-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;

export const scopeGranted = ({
  effectiveGrants,
  scope,
}: {
  effectiveGrants: EffectiveGrants;
  scope: string;
}): boolean => scopePreflightFailure({ effectiveGrants, scope }) === undefined;

type ScopePreflightFailureArgs = {
  additionalScopes?: readonly string[] | undefined;
  scope?: string | undefined;
  effectiveGrants: EffectiveGrants;
  serverUrl?: string | undefined;
};

export const scopePreflightFailure = ({
  additionalScopes,
  scope,
  effectiveGrants,
  serverUrl,
}: ScopePreflightFailureArgs):
  Extract<CommandUnavailableCause, { type: "missing-scope" }> | undefined => {
  switch (effectiveGrants.type) {
    case "unknown":
      return undefined;
    case "known":
      break;
    default:
      effectiveGrants satisfies never;
      return panic("Unexpected effective grant state");
  }
  const grantedScopes = effectiveGrants.scopes;

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
