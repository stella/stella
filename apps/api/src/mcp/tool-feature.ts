import { env } from "@/api/env";
import type { McpToolFeatureFlag } from "@/api/mcp/tool-types";
import { isLocalDevOpen } from "@/api/runtime-mode";

/**
 * Whether a deployment-gated agent-facing surface is available.
 *
 * A tool tagged with a `feature` is advertised and dispatchable only while
 * that flag is on, mirroring the backing route's own gate (e.g. the public
 * legal-corpus routes use `isLocalDevOpen() || env.FEATURE_PUBLIC_LAW`).
 * Untagged tools are always available, and local development sees everything
 * so local work is not blocked.
 *
 * This is the single chokepoint every gated surface shares: the tool list,
 * the dispatch guard, the resource list, and the connect-time instructions
 * that point at a gated workflow. It lives in its own module, importing only
 * the env, so the resource and instruction modules can reach it without
 * pulling in the tool registry they are listed beside.
 */
export const isMcpToolFeatureEnabled = (
  feature: McpToolFeatureFlag | undefined,
): boolean => feature === undefined || isLocalDevOpen() || env[feature];
