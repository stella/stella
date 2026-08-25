import {
  getMcpResourceScopes,
  getMcpResourceUrl,
  MCP_MODES,
} from "@/api/mcp/constants";
import type { McpMode } from "@/api/mcp/constants";

const OAUTH_RESOURCE_NAMES = {
  anonymized: "Stella MCP anonymized",
  default: "Stella MCP",
  documents: "Stella MCP documents",
} as const satisfies Record<McpMode, string>;

/**
 * One source of truth for Better Auth's persisted and runtime OAuth resource
 * policy. Existing 1.6 clients are linked to every entry during the bridge
 * backfill, which preserves the old global `validAudiences` capability. New
 * 1.7 registrations receive an explicit subset at creation time.
 */
export const getBetterAuthOAuthResources = () =>
  MCP_MODES.map((mode) => ({
    allowedScopes: [...getMcpResourceScopes(mode)],
    identifier: getMcpResourceUrl(mode),
    name: OAUTH_RESOURCE_NAMES[mode],
  }));
