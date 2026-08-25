import {
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_DOCUMENTS_HTTP_PATH,
  MCP_HTTP_PATH,
} from "@stll/api-contract";

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
  // restricts invoke_capability to the three lifecycle IDs, so this grant does
  // not expose unrelated matter mutations through that endpoint.
  "stella:matters_write",
] as const;

export const ROOT_MCP_DISCOVERY_PATH =
  "/.well-known/oauth-protected-resource" as const;
export const MCP_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_HTTP_PATH}` as const;
export const MCP_DOCUMENTS_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_DOCUMENTS_HTTP_PATH}` as const;
export const MCP_ANONYMIZED_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_ANONYMIZED_HTTP_PATH}` as const;

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
} as const;

export type McpMode = keyof typeof MCP_RESOURCE_MODE_CONFIG;

export const MCP_MODES = [
  "default",
  "documents",
  "anonymized",
] as const satisfies readonly McpMode[];

type MissingMcpMode = Exclude<McpMode, (typeof MCP_MODES)[number]>;
true satisfies MissingMcpMode extends never ? true : never;

export const getMcpResourceModeConfig = (mode: McpMode) =>
  MCP_RESOURCE_MODE_CONFIG[mode];

export const getMcpResourceScopes = (mode: McpMode) =>
  getMcpResourceModeConfig(mode).resourceScopes;

export const buildBetterAuthOAuthResources = (baseUrl: string) =>
  MCP_MODES.map((mode) => {
    const config = getMcpResourceModeConfig(mode);
    return {
      allowedScopes: [...config.resourceScopes],
      identifier: new URL(
        config.httpPath,
        `${baseUrl.replace(/\/$/u, "")}/`,
      ).toString(),
      name: config.resourceName,
    };
  });

export const normalizeBetterAuthOAuthBaseUrl = (value: string) => {
  const parsed = URL.parse(value);
  if (
    parsed === null ||
    parsed.protocol !== "https:" ||
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
