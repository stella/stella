import { panic } from "better-result";

import {
  MICROSOFT365_CAPABILITIES,
  type Microsoft365Capability,
} from "@stll/api-contract/microsoft365";

// This catalogue is the only source of Graph scopes for delegated reads.
// A write or send scope is rejected when a literal is added to it.
type ReadOnlyGraphScope<S extends string> =
  Lowercase<S> extends `${string}write${string}` | `${string}send${string}`
    ? never
    : S;

const readOnlyScope = <const S extends string>(
  scope: ReadOnlyGraphScope<S>,
): S => scope;

const BASE_SCOPES = [
  readOnlyScope("offline_access"),
  readOnlyScope("https://graph.microsoft.com/User.Read"),
] as const;

// Files.Read.All and Sites.Read.All require tenant admin consent; requesting
// them here does not grant them without Microsoft's consent response.
const CAPABILITY_SCOPES = {
  "files.read": [
    readOnlyScope("https://graph.microsoft.com/Files.Read.All"),
    readOnlyScope("https://graph.microsoft.com/Sites.Read.All"),
  ],
  "calendar.read": [
    readOnlyScope("https://graph.microsoft.com/Calendars.Read"),
  ],
} as const satisfies Record<Microsoft365Capability, readonly string[]>;

export const LEGACY_FILE_CAPABILITIES = ["files.read"] as const;

export const delegatedReadScopes = (
  capabilities: readonly Microsoft365Capability[],
): string =>
  [
    ...new Set([
      ...BASE_SCOPES,
      ...capabilities.flatMap((capability) => CAPABILITY_SCOPES[capability]),
    ]),
  ].join(" ");

type SharepointPolicy = {
  sharepointConnectionEnabled: boolean;
  microsoft365CalendarReadEnabled: boolean;
};

export const capabilityEnabled = (
  policy: SharepointPolicy | null | undefined,
  capability: Microsoft365Capability,
): boolean => {
  if (!policy) {
    return false;
  }
  switch (capability) {
    case "files.read":
      return policy.sharepointConnectionEnabled;
    case "calendar.read":
      return policy.microsoft365CalendarReadEnabled;
    default: {
      capability satisfies never;
      return panic("Unknown Microsoft 365 capability");
    }
  }
};

const normalizeScope = (scope: string) =>
  scope.replace(/^https:\/\/graph\.microsoft\.com\//iu, "").toLowerCase();

export const scopeSet = (scope: string | null) =>
  [
    ...new Set((scope ?? "").split(/\s+/u).filter(Boolean).map(normalizeScope)),
  ].toSorted();

export const grantedCapabilities = (scope: string | null) => {
  const granted = new Set(scopeSet(scope));
  return MICROSOFT365_CAPABILITIES.filter((capability) =>
    CAPABILITY_SCOPES[capability].every((required) =>
      granted.has(normalizeScope(required)),
    ),
  );
};

type DelegatedScopesOptions = {
  requested: readonly Microsoft365Capability[];
  grantedScope: string | null;
  policy: SharepointPolicy | null | undefined;
};

// Retain only provider grants that the current org policy still permits.
// Unknown provider scopes never become a new authorization request.
export const delegatedScopes = ({
  requested,
  grantedScope,
  policy,
}: DelegatedScopesOptions): string => {
  const granted = new Set(scopeSet(grantedScope));
  const retained = MICROSOFT365_CAPABILITIES.filter((capability) =>
    capabilityEnabled(policy, capability),
  )
    .flatMap((capability) => CAPABILITY_SCOPES[capability])
    .filter((scope) => granted.has(normalizeScope(scope)));
  return [
    ...new Set([
      ...BASE_SCOPES,
      ...retained,
      ...requested
        .filter((capability) => capabilityEnabled(policy, capability))
        .flatMap((capability) => CAPABILITY_SCOPES[capability]),
    ]),
  ].join(" ");
};

export const boundGrantedScope = ({
  ceiling,
  returned,
}: {
  ceiling: string | null;
  returned: string | null;
}): string => {
  const allowed = new Set(scopeSet(ceiling));
  return (returned ?? "")
    .split(/\s+/u)
    .filter((scope) => allowed.has(normalizeScope(scope)))
    .join(" ");
};

export const consentedScopes = ({
  providerScope,
  requestedScope,
  policy,
}: {
  providerScope: string | undefined;
  requestedScope: string;
  policy: SharepointPolicy | null | undefined;
}): string => {
  // Microsoft may omit the response scope; in that case the token carries
  // the scopes requested in this exact authorization or refresh exchange.
  const grantedScope = providerScope ?? requestedScope;
  const allowed = new Set(
    scopeSet(
      delegatedScopes({ requested: [], grantedScope: requestedScope, policy }),
    ),
  );
  const ceiling = requestedScope
    .split(/\s+/u)
    .filter((scope) => allowed.has(normalizeScope(scope)))
    .join(" ");
  return boundGrantedScope({ ceiling, returned: grantedScope });
};
