import {
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_DOCUMENTS_HTTP_PATH,
  MCP_HTTP_PATH,
  MCP_LAW_HTTP_PATH,
  MCP_OAUTH_PROTOCOL_SCOPES,
} from "@stll/api-contract";

import type { ToolScope } from "@/api/mcp/tool-types";

/**
 * Least-privilege remote-host surface for document workflows. Hosted clients
 * commonly request every scope in protected-resource metadata, so this
 * resource advertises only the grants its projected tool registry can use.
 */
export const MCP_DOCUMENTS_RESOURCE_SCOPES = [
  "stella:read",
  "stella:documents_write",
  // The canonical presigned-upload lifecycle currently owns one scope across
  // entity-create and entity-version purposes. The documents MCP audience
  // restricts write_capability to the three lifecycle IDs, so this grant does
  // not expose unrelated matter mutations through that endpoint.
  "stella:matters_write",
] as const;

/**
 * The public legal corpus audience reads and searches shared case law and
 * legislation; no matter, document, contact or billing data is reachable
 * through it, so it advertises no write grant and no anonymized pairing.
 * `registry.test.ts` pins this list to the scopes its projected tools actually
 * carry, so a tool added to that surface cannot widen the grant silently.
 */
const LAW_PROJECTED_TOOL_SCOPES = [
  "stella:search",
  "stella:read",
  "stella:law_read",
] as const satisfies readonly ToolScope[];

export const LEGAL_RESOLVE_RESOURCE_ROUTES = {
  decision: {
    path: "/case/:country/decisions/resolve",
    requiredScope: "stella:law_read",
  },
  law: {
    path: "/law/:country/citations/resolve",
    requiredScope: "stella:law_read",
  },
} as const satisfies Record<
  "decision" | "law",
  { path: string; requiredScope: ToolScope }
>;

// One entry per scope: a tool and a REST route may consume the same one.
export const MCP_LAW_RESOURCE_SCOPES = [
  ...new Set([
    ...LAW_PROJECTED_TOOL_SCOPES,
    ...Object.values(LEGAL_RESOLVE_RESOURCE_ROUTES).map(
      ({ requiredScope }) => requiredScope,
    ),
  ]),
];

export const ROOT_MCP_DISCOVERY_PATH =
  "/.well-known/oauth-protected-resource" as const;
export const MCP_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_HTTP_PATH}` as const;
export const MCP_DOCUMENTS_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_DOCUMENTS_HTTP_PATH}` as const;
export const MCP_ANONYMIZED_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_ANONYMIZED_HTTP_PATH}` as const;
export const MCP_LAW_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_LAW_HTTP_PATH}` as const;

export const MCP_RESOURCE_MODE_CONFIG = {
  default: {
    discoveryPath: MCP_DISCOVERY_PATH,
    httpPath: MCP_HTTP_PATH,
    resourceName: "Stella MCP",
    resourceScopes: MCP_DEFAULT_RESOURCE_SCOPES,
  },
  documents: {
    discoveryPath: MCP_DOCUMENTS_DISCOVERY_PATH,
    httpPath: MCP_DOCUMENTS_HTTP_PATH,
    resourceName: "Stella MCP documents",
    resourceScopes: MCP_DOCUMENTS_RESOURCE_SCOPES,
  },
  anonymized: {
    discoveryPath: MCP_ANONYMIZED_DISCOVERY_PATH,
    httpPath: MCP_ANONYMIZED_HTTP_PATH,
    resourceName: "Stella MCP anonymized",
    resourceScopes: MCP_ANONYMIZED_RESOURCE_SCOPES,
  },
  law: {
    discoveryPath: MCP_LAW_DISCOVERY_PATH,
    httpPath: MCP_LAW_HTTP_PATH,
    resourceName: "Stella MCP law",
    resourceScopes: MCP_LAW_RESOURCE_SCOPES,
  },
} as const;

export type McpMode = keyof typeof MCP_RESOURCE_MODE_CONFIG;

export const MCP_MODES = [
  "default",
  "documents",
  "anonymized",
  "law",
] as const satisfies readonly McpMode[];

type MissingMcpMode = Exclude<McpMode, (typeof MCP_MODES)[number]>;
true satisfies MissingMcpMode extends never ? true : never;

export const getMcpResourceModeConfig = (mode: McpMode) =>
  MCP_RESOURCE_MODE_CONFIG[mode];

export const getMcpResourceScopes = (mode: McpMode) =>
  getMcpResourceModeConfig(mode).resourceScopes;

/**
 * The OAuth resource set Better Auth is configured with, one entry per
 * audience.
 *
 * Adding an audience widens this set, and the startup census
 * (`ensureBetterAuthOAuthPolicy`) refuses to boot until the database matches
 * it. Startup does not repair an existing database on its own: seeding runs
 * only against an entirely empty auth database, and `resourceSeedMode: "none"`
 * in `lib/auth.ts` keeps resource creation out of the request path.
 *
 * Reconciling them is the deploy's job, and it needs no operator step: the
 * `better-auth-oauth-resources` online repair
 * (`db/better-auth-oauth-resource-repair.ts`, registered in
 * `db/online-migrations.ts`) runs on the migrate entrypoint before the API
 * rolls, inserts any resource this set names and the table lacks, and links
 * every existing client registration to it. It also upgrades the exact
 * predecessor policy that omitted protocol scopes from token issuance.
 * `better-auth-oauth-policy-census.db.test.ts` pins that, the idempotence, and
 * the refusal to overwrite a conflicting definition.
 */
export const buildBetterAuthOAuthResources = (baseUrl: string) =>
  MCP_MODES.map((mode) => {
    const config = getMcpResourceModeConfig(mode);
    return {
      // Better Auth intersects the entire grant with this list and persists
      // that result on refresh tokens. Protocol scopes must survive issuance;
      // protected-resource metadata still advertises only resourceScopes.
      allowedScopes: [...config.resourceScopes, ...MCP_OAUTH_PROTOCOL_SCOPES],
      identifier: new URL(
        config.httpPath,
        `${baseUrl.replace(/\/$/u, "")}/`,
      ).toString(),
      name: config.resourceName,
    };
  });

/**
 * The allowed scopes a stored resource row carried before protocol scopes
 * joined the issuance policy: the configured set minus
 * `MCP_OAUTH_PROTOCOL_SCOPES`.
 *
 * Contract step of an expand/contract rollout. The previous release accepts
 * both this set and the configured set at boot, so the deploy repair now
 * upgrades rows holding exactly this set to the configured set, and the boot
 * census accepts only the configured set.
 */
export const predecessorOAuthResourceScopes = (
  allowedScopes: readonly string[],
): string[] =>
  allowedScopes.filter(
    (scope) =>
      !MCP_OAUTH_PROTOCOL_SCOPES.some(
        (protocolScope) => protocolScope === scope,
      ),
  );

export const normalizeBetterAuthOAuthBaseUrl = (value: string) => {
  const parsed = URL.parse(value);
  if (
    parsed?.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  return parsed.origin;
};
