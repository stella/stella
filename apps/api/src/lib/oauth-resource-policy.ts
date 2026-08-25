import { getMcpBaseUrl } from "@/api/mcp/constants";
import { buildBetterAuthOAuthResources } from "@/api/mcp/resource-policy-contract";

/**
 * One source of truth for Better Auth's persisted and runtime OAuth resource
 * policy. Existing 1.6 clients are linked to every entry during the bridge
 * backfill, which preserves the old global `validAudiences` capability. New
 * 1.7 registrations receive an explicit subset at creation time.
 */
export const getBetterAuthOAuthResources = () =>
  buildBetterAuthOAuthResources(getMcpBaseUrl());
