// The runtime-fetch call site (spec 051 S5.2 runtime + S5.3 + S5.5). Startup
// always uses the baked-in tree (instant, offline); this module keeps the
// per-origin cache current and, when a validated fetch diverges from the
// baked-in tree, lets the next command build from the cached listings.
//
// Two entry points:
//   - `resolveCommandTree`: read-only, no network. Picks the baked-in tree, or
//     the cached-listings tree when the cache shows a non-empty delta, and
//     returns the one-line stderr notice for that case.
//   - `refreshRegistryCache`: fetch `tools/list`, validate through the S5.5
//     trust boundary, diff vs baked-in, and write the cache. Fails closed: any
//     transport/validation failure leaves the trusted baked-in tree in place.
//
// Both share the ONE pure `generateRouteMap` and the ONE baked-in Annotation
// Table, so unknown fetched tools get the same S1 heuristic defaults as the
// build-time path.

import { Result } from "better-result";
import { access, readFile } from "node:fs/promises";

import { TOOL_ANNOTATIONS } from "./annotations.js";
import { loadBakedCapabilityCatalog } from "./capability-catalog-load.js";
import { fetchLatestCliVersion } from "./cli-release-channel.js";
import { buildVersionNudge } from "./cli-version-nudge.js";
import { buildCliRouteTree } from "./generate-capability-tree.js";
import { CLI_VERSION } from "./generated/cli-version.js";
import { generatedRouteMap } from "./generated/route-map.js";
import {
  fetchToolsListRaw,
  type McpClientError,
  type RawToolsList,
} from "./mcp-client.js";
import {
  CACHE_SCHEMA_VERSION,
  cachePathFor,
  computeDelta,
  DEFAULT_TTL_SECONDS,
  isCacheStale,
  isDeltaEmpty,
  readCacheFile,
  writeCacheFile,
  type CacheEnv,
  type RegistryCacheFile,
  type RegistryDelta,
} from "./registry-cache.js";
import { validateFetchedToolsList } from "./registry-trust.js";
import type { RegistryToolListing, RouteNode } from "./route-types.js";

const SNAPSHOT_URL = new URL(
  "generated/registry-snapshot.json",
  import.meta.url,
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cacheFileExists = async (filePath: string): Promise<boolean> =>
  Result.isOk(await Result.tryPromise(async () => await access(filePath)));

/** Load the baked-in listings (the committed snapshot) for the delta diff. */
const loadBakedListings = async (): Promise<readonly RegistryToolListing[]> => {
  const parsed = await Result.tryPromise({
    try: async (): Promise<unknown> =>
      JSON.parse(await readFile(SNAPSHOT_URL, "utf-8")),
    catch: (cause) => cause,
  });
  if (Result.isError(parsed) || !Array.isArray(parsed.value)) {
    return [];
  }
  const listings: RegistryToolListing[] = [];
  for (const entry of parsed.value) {
    // The snapshot is committed, trusted data; project the diff-relevant fields
    // (name identity + schema shape) with plain guards, no casts.
    if (!isRecord(entry)) {
      continue;
    }
    const name = entry["name"];
    const inputSchema = entry["inputSchema"];
    const description = entry["description"];
    if (typeof name === "string" && isRecord(inputSchema)) {
      listings.push({
        name,
        description: typeof description === "string" ? description : "",
        inputSchema,
      });
    }
  }
  return listings;
};

/** A tool whose invocation needs its own scope plus at least one more. */
const isCompoundTool = (name: string): boolean => {
  const annotation = TOOL_ANNOTATIONS[name];
  const additionalScopes = annotation?.additionalScopes;
  return (
    annotation?.scope !== undefined &&
    additionalScopes !== undefined &&
    additionalScopes.length > 0
  );
};

/**
 * A `tools/list` response is a projection, not proof that a baked tool was
 * removed from the server. Restore a baked listing the response attested it
 * omitted, so the command stays in the tree and the server answers the call:
 * - `feature`: gated off in this deployment, so invoking it returns the
 *   server's `feature_disabled` with its real message instead of the CLI
 *   claiming the command does not exist.
 * - `scope`: only compound tools, whose local all-scopes preflight must stay
 *   reachable. Single-scope tools follow the live projection.
 *
 * Attestation is required: grants alone are insufficient, because an older
 * server may lack the tool entirely while echoing the same limited grants.
 * Unknown live tools survive either way.
 */
const retainAttestedOmittedListings = ({
  fetched,
  baked,
  featureOmittedTools,
  scopeOmittedTools,
}: {
  fetched: readonly RegistryToolListing[];
  baked: readonly RegistryToolListing[];
  featureOmittedTools: readonly string[] | undefined;
  scopeOmittedTools: readonly string[] | undefined;
}): readonly RegistryToolListing[] => {
  const retainable = new Set(featureOmittedTools);
  for (const name of scopeOmittedTools ?? []) {
    if (isCompoundTool(name)) {
      retainable.add(name);
    }
  }
  if (retainable.size === 0) {
    return fetched;
  }
  const names = new Set(fetched.map((listing) => listing.name));
  const retained = baked.filter(
    (listing) => !names.has(listing.name) && retainable.has(listing.name),
  );
  return retained.length === 0 ? fetched : [...fetched, ...retained];
};

/** How many diverged tool names the notice spells out before summarizing. */
const NOTICE_TOOL_NAME_LIMIT = 8;

const formatNoticeToolNames = (names: readonly string[]): string => {
  const shown = names.slice(0, NOTICE_TOOL_NAME_LIMIT).join(", ");
  const overflow = names.length - NOTICE_TOOL_NAME_LIMIT;
  return overflow > 0 ? `${shown} +${overflow} more` : shown;
};

/**
 * The one-line stderr notice for a diverged registry (spec S5.3). It names the
 * tools: counts alone leave no way to tell which command changed, and no
 * command prints the delta.
 */
const divergenceNotice = (delta: RegistryDelta): string => {
  const segments: string[] = [];
  for (const [label, names] of [
    ["added", delta.added],
    ["removed", delta.removed],
    ["changed", delta.changed],
  ] as const) {
    if (names.length > 0) {
      segments.push(`${label} ${formatNoticeToolNames(names)}`);
    }
  }
  return `server registry differs: ${segments.join("; ")}\n`;
};

export type ResolvedCommandTree = {
  tree: RouteNode;
  notice?: string;
  /** Baked tool names the server attested are gated off in this deployment. */
  disabledTools: readonly string[];
};

/**
 * Pick the command tree for this invocation without any network (spec S5.3).
 * The baked-in tree is the default; a valid same-origin cache with a non-empty
 * delta builds from the cached listings and carries the one-line stderr notice
 * for that divergence. The notice reflects a persistent state (the server tree
 * differs from the built-in tree until the next refresh reconciles the cache),
 * so it is emitted per invocation while divergent rather than suppressed after
 * the first: this read path takes no network and writes no disk. A cache whose
 * only divergence is a single-scope omission also builds from the listings, so
 * a command this token cannot use is not exposed; it carries no notice, because
 * the registry itself did not diverge. Provenance is pinned: a cache whose
 * `serverOrigin` differs is ignored (rule 5), and a cached tree that fails to
 * build falls back to baked-in (rule 6).
 */
export const resolveCommandTree = async ({
  serverOrigin,
  env,
}: {
  serverOrigin: string | undefined;
  env: CacheEnv;
}): Promise<ResolvedCommandTree> => {
  if (serverOrigin === undefined) {
    return { tree: generatedRouteMap, disabledTools: [] };
  }
  const file = await readCacheFile(cachePathFor(serverOrigin, env));
  if (file === undefined || file.serverOrigin !== serverOrigin) {
    return { tree: generatedRouteMap, disabledTools: [] };
  }
  // Tools the server attested it omits because a deployment feature is off.
  // They stay in the tree (the server answers a call with its own
  // feature_disabled), and help/tools list mark them so nobody has to try.
  const disabledTools = file.featureOmittedTools ?? [];
  const prunedByScope = (file.scopeOmittedTools ?? []).some(
    (name) => !isCompoundTool(name),
  );
  if (isDeltaEmpty(file.delta) && !prunedByScope) {
    return { tree: generatedRouteMap, disabledTools };
  }
  // Rebuild through the SAME shared builder codegen uses (curated tools from
  // the cached listings + the baked capability merge), so a diverged registry
  // never drops the generated capability leaves. A missing/corrupt catalog or
  // a tree that fails to build falls back to the baked-in tree (rule 6).
  const entries = await loadBakedCapabilityCatalog();
  if (entries === null) {
    return { tree: generatedRouteMap, disabledTools };
  }
  const listings = retainAttestedOmittedListings({
    fetched: file.listings,
    baked: await loadBakedListings(),
    featureOmittedTools: file.featureOmittedTools,
    scopeOmittedTools: file.scopeOmittedTools,
  });
  const built = Result.try(
    () =>
      buildCliRouteTree({
        listings,
        annotations: TOOL_ANNOTATIONS,
        entries,
      }).tree,
  );
  if (Result.isError(built)) {
    return { tree: generatedRouteMap, disabledTools };
  }
  return isDeltaEmpty(file.delta)
    ? { tree: built.value, disabledTools }
    : {
        tree: built.value,
        notice: divergenceNotice(file.delta),
        disabledTools,
      };
};

/** The outcome of a cache-refresh attempt (spec S5.3/S5.5 + addendum nudge). */
export type RefreshOutcome =
  | { status: "skipped"; reason: "no-cache" | "fresh" }
  | { status: "failed"; warning: string }
  | { status: "refreshed"; deltaEmpty: boolean; nudge?: string };

type FetchRaw = () => Promise<Result<RawToolsList, McpClientError>>;
type FetchLatestVersion = () => Promise<string | undefined>;

/**
 * Refresh the per-origin cache (spec S5.3). Force-refreshes on `auth login`;
 * otherwise only refreshes an existing cache once it is stale (a missing cache
 * stays offline-instant and is seeded at login). Fails closed on any transport
 * or trust-boundary violation, keeping the baked-in tree (rule 6).
 */
export const refreshRegistryCache = async ({
  serverOrigin,
  token,
  env,
  now = Date.now(),
  force = false,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  currentVersion = CLI_VERSION,
  fetchRaw,
  fetchLatestVersion,
  bakedListings,
}: {
  serverOrigin: string;
  token: string;
  env: CacheEnv;
  now?: number;
  force?: boolean;
  ttlSeconds?: number;
  currentVersion?: string;
  fetchRaw?: FetchRaw;
  fetchLatestVersion?: FetchLatestVersion;
  bakedListings?: readonly RegistryToolListing[];
}): Promise<RefreshOutcome> => {
  const filePath = cachePathFor(serverOrigin, env);
  const existing = await readCacheFile(filePath);

  if (!force) {
    if (existing === undefined) {
      // Only a genuinely absent cache stays offline-instant (seeded at login).
      // A file that exists but no longer validates (an older schema version
      // left behind by an upgrade, or corruption) would otherwise be skipped
      // forever, freezing the delta notice and the update nudge until the next
      // login; treat it as stale and rebuild it.
      if (!(await cacheFileExists(filePath))) {
        return { status: "skipped", reason: "no-cache" };
      }
    } else if (!isCacheStale(existing, now)) {
      return { status: "skipped", reason: "fresh" };
    }
  }

  const fetcher: FetchRaw =
    fetchRaw ??
    (async () => await fetchToolsListRaw({ serverUrl: serverOrigin, token }));
  const latestFetcher = fetchLatestVersion ?? fetchLatestCliVersion;
  const [raw, latestVersion] = await Promise.all([
    fetcher(),
    Result.tryPromise(async () => await latestFetcher()).then((result) =>
      Result.isOk(result) ? result.value : undefined,
    ),
  ]);
  if (Result.isError(raw)) {
    return {
      status: "failed",
      warning: `registry refresh skipped: ${raw.error.message}`,
    };
  }

  const trust = validateFetchedToolsList(raw.value.rawBody);
  if (!trust.ok) {
    return {
      status: "failed",
      warning: `registry refresh rejected (using built-in commands): ${trust.violation}`,
    };
  }

  const baked = bakedListings ?? (await loadBakedListings());
  // Every omission the server attested, whatever the reason. Diffing against a
  // projection without them counts a tool the server still owns as removed, and
  // the delta then never reconciles: the notice fires on every invocation.
  const delta = computeDelta({
    baked,
    fetched: trust.listings,
    omittedTools: [
      ...(raw.value.scopeOmittedTools ?? []),
      ...(raw.value.featureOmittedTools ?? []),
    ],
  });

  // Resolve the update channel from npm, the publication source of truth. The
  // server still supplies only its independently-owned minimum-version policy.
  const nudge = buildVersionNudge({
    current: currentVersion,
    latest: latestVersion,
    minimum: raw.value.cliMinimum,
    lastNudged: existing?.lastNudgedVersion,
  });
  const lastNudgedVersion = nudge.nudgeVersion ?? existing?.lastNudgedVersion;

  const file: RegistryCacheFile = {
    version: CACHE_SCHEMA_VERSION,
    serverOrigin,
    fetchedAt: new Date(now).toISOString(),
    ttlSeconds,
    toolsListHash: trust.toolsListHash,
    listings: trust.listings,
    delta,
    ...(raw.value.grantedScopes === undefined
      ? {}
      : { grantedScopes: raw.value.grantedScopes }),
    ...(raw.value.scopeOmittedTools === undefined
      ? {}
      : { scopeOmittedTools: raw.value.scopeOmittedTools }),
    ...(raw.value.featureOmittedTools === undefined
      ? {}
      : { featureOmittedTools: raw.value.featureOmittedTools }),
    ...(lastNudgedVersion === undefined ? {} : { lastNudgedVersion }),
  };
  await writeCacheFile(filePath, file);
  return {
    status: "refreshed",
    deltaEmpty: isDeltaEmpty(delta),
    ...(nudge.line === undefined ? {} : { nudge: nudge.line }),
  };
};
