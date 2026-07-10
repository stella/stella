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
import { readFile } from "node:fs/promises";

import { TOOL_ANNOTATIONS } from "./annotations.js";
import { loadBakedCapabilityCatalog } from "./capability-catalog-load.js";
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
} from "./registry-cache.js";
import { validateFetchedToolsList } from "./registry-trust.js";
import type { RegistryToolListing, RouteNode } from "./route-types.js";

const SNAPSHOT_URL = new URL(
  "generated/registry-snapshot.json",
  import.meta.url,
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

/** The one-line stderr notice for a diverged registry (spec S5.3). */
const divergenceNotice = (file: RegistryCacheFile): string =>
  `server registry differs (+${file.delta.added.length} −${file.delta.removed.length} ~${file.delta.changed.length}); see 'stella tools list'\n`;

/**
 * Pick the command tree for this invocation without any network (spec S5.3).
 * The baked-in tree is the default; a valid same-origin cache with a non-empty
 * delta builds from the cached listings and carries the one-line stderr notice
 * for that divergence. The notice reflects a persistent state (the server tree
 * differs from the built-in tree until the next refresh reconciles the cache),
 * so it is emitted per invocation while divergent rather than suppressed after
 * the first: this read path takes no network and writes no disk. Provenance is
 * pinned: a cache whose `serverOrigin` differs is ignored (rule 5), and a
 * cached tree that fails to build falls back to baked-in (rule 6).
 */
export const resolveCommandTree = async ({
  serverOrigin,
  env,
}: {
  serverOrigin: string | undefined;
  env: CacheEnv;
}): Promise<{ tree: RouteNode; notice?: string }> => {
  if (serverOrigin === undefined) {
    return { tree: generatedRouteMap };
  }
  const file = await readCacheFile(cachePathFor(serverOrigin, env));
  if (file === undefined || file.serverOrigin !== serverOrigin) {
    return { tree: generatedRouteMap };
  }
  if (isDeltaEmpty(file.delta)) {
    return { tree: generatedRouteMap };
  }
  // Rebuild through the SAME shared builder codegen uses (curated tools from
  // the cached listings + the baked capability merge), so a diverged registry
  // never drops the generated capability leaves. A missing/corrupt catalog or
  // a tree that fails to build falls back to the baked-in tree (rule 6).
  const entries = await loadBakedCapabilityCatalog();
  if (entries === null) {
    return { tree: generatedRouteMap };
  }
  const built = Result.try(
    () =>
      buildCliRouteTree({
        listings: file.listings,
        annotations: TOOL_ANNOTATIONS,
        entries,
      }).tree,
  );
  if (Result.isError(built)) {
    return { tree: generatedRouteMap };
  }
  return { tree: built.value, notice: divergenceNotice(file) };
};

/** The outcome of a cache-refresh attempt (spec S5.3/S5.5 + addendum nudge). */
export type RefreshOutcome =
  | { status: "skipped"; reason: "no-cache" | "fresh" }
  | { status: "failed"; warning: string }
  | { status: "refreshed"; deltaEmpty: boolean; nudge?: string };

type FetchRaw = () => Promise<Result<RawToolsList, McpClientError>>;

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
  bakedListings?: readonly RegistryToolListing[];
}): Promise<RefreshOutcome> => {
  const filePath = cachePathFor(serverOrigin, env);
  const existing = await readCacheFile(filePath);

  if (!force) {
    if (existing === undefined) {
      return { status: "skipped", reason: "no-cache" };
    }
    if (!isCacheStale(existing, now)) {
      return { status: "skipped", reason: "fresh" };
    }
  }

  const fetcher: FetchRaw =
    fetchRaw ??
    (async () => await fetchToolsListRaw({ serverUrl: serverOrigin, token }));
  const raw = await fetcher();
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
  const delta = computeDelta(baked, trust.listings);

  // CLI update nudge (spec 051 addendum): evaluate the advertised version headers
  // against this build; anti-nag on the version last nudged for this origin.
  const nudge = buildVersionNudge({
    current: currentVersion,
    latest: raw.value.cliLatest,
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
    ...(lastNudgedVersion === undefined ? {} : { lastNudgedVersion }),
  };
  await writeCacheFile(filePath, file);
  return {
    status: "refreshed",
    deltaEmpty: isDeltaEmpty(delta),
    ...(nudge.line === undefined ? {} : { nudge: nudge.line }),
  };
};
