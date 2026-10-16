import { panic } from "better-result";
import * as v from "valibot";

import {
  MICROSOFT365_CAPABILITIES,
  type Microsoft365Capability,
} from "@stll/api-contract/microsoft365";
// Read capabilities cannot introduce a write scope into delegated consent.
type ReadOnlyGraphScope<S extends string> =
  Lowercase<S> extends `${string}write${string}` | `${string}send${string}`
    ? never
    : S;
const readOnlyScope = <const S extends string>(
  scope: ReadOnlyGraphScope<S>,
): S => scope;

const delegatedScopeSchema = v.pipe(
  v.string(),
  v.brand("Microsoft365ReadScopes"),
);
export type Microsoft365ReadScopes = v.InferOutput<typeof delegatedScopeSchema>;

const BASE_SCOPES = [
  readOnlyScope("offline_access"),
  readOnlyScope("https://graph.microsoft.com/User.Read"),
];
const CAPABILITY_SCOPES = {
  "files.read": [
    readOnlyScope("https://graph.microsoft.com/Files.Read.All"),
    readOnlyScope("https://graph.microsoft.com/Sites.Read.All"),
  ],
  "calendar.read": [
    readOnlyScope("https://graph.microsoft.com/Calendars.Read"),
  ],
} as const satisfies Record<Microsoft365Capability, readonly string[]>;

const normalizeScope = (scope: string) =>
  scope.replace(/^https:\/\/graph\.microsoft\.com\//iu, "").toLowerCase();

export const grantedCapabilities = (scope: string | null) => {
  const granted = new Set((scope ?? "").split(/\s+/u).map(normalizeScope));
  return MICROSOFT365_CAPABILITIES.filter((capability) =>
    CAPABILITY_SCOPES[capability].every((required) =>
      granted.has(normalizeScope(required)),
    ),
  );
};

// Preserve known read grants while requesting incremental consent. Unknown scope
// strings never become authorization requests (in particular, write grants).
export const delegatedScopes = (
  requested: readonly Microsoft365Capability[],
  grantedScope: string | null,
) => {
  const granted = new Set(
    (grantedScope ?? "").split(/\s+/u).map(normalizeScope),
  );
  const retained = Object.values(CAPABILITY_SCOPES)
    .flat()
    .filter((scope) => granted.has(normalizeScope(scope)));
  return v.parse(
    delegatedScopeSchema,
    [
      ...new Set([
        ...BASE_SCOPES,
        ...retained,
        ...requested.flatMap((capability) => CAPABILITY_SCOPES[capability]),
      ]),
    ].join(" "),
  );
};

type Microsoft365Policy = {
  microsoft365ConnectionEnabled: boolean;
  microsoft365FilesReadEnabled: boolean;
  microsoft365CalendarReadEnabled: boolean;
};
export const capabilityEnabled = (
  policy: Microsoft365Policy | undefined,
  capability: Microsoft365Capability,
): boolean => {
  if (!policy?.microsoft365ConnectionEnabled) {
    return false;
  }
  switch (capability) {
    case "files.read":
      return policy.microsoft365FilesReadEnabled;
    case "calendar.read":
      return policy.microsoft365CalendarReadEnabled;
    default: {
      capability satisfies never;
      return panic("Unknown Microsoft 365 capability");
    }
  }
};
