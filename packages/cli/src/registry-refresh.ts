import { Result } from "better-result";
// Runtime registry fetches validate caller listings for this invocation only.
// resolveCommandTree consumes a current response or the baked-in baseline;
// refreshRegistryCache persists deployment omissions and version metadata.
// Both paths share the build-time route generator and annotation table.
import { access, readFile } from "node:fs/promises";
import { Temporal } from "temporal-polyfill/full";

import type { CliActionAdmissionRefusal } from "./action-admission-refusal.js";
import { loadBakedCapabilityCatalog } from "./capability-catalog-load.js";
import { fetchLatestCliVersion } from "./cli-release-channel.js";
import { buildVersionNudge } from "./cli-version-nudge.js";
import {
  hasFeatureCommands,
  projectFeatureCommands,
} from "./feature-command-projection.js";
import type { CallerFeatureAccess } from "./feature-command-projection.js";
import type { CapabilityCatalogEntry } from "./generate-capability-tree.js";
import { buildCliRouteTree } from "./generate-capability-tree.js";
import { CLI_VERSION } from "./generated/cli-version.js";
import { generatedRouteMap } from "./generated/route-map.js";
import { generatedToolAnnotations as TOOL_ANNOTATIONS } from "./generated/tool-annotations.js";
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
import {
  type DisabledCommands,
  NO_DISABLED_COMMANDS,
  type RegistryToolListing,
  type RouteNode,
  type ToolAnnotation,
} from "./route-types.js";

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
    const cli = entry["cli"];
    const meta = entry["_meta"];
    const cliFeatureId = isRecord(cli) ? cli["featureId"] : undefined;
    const metaFeatureId = isRecord(meta) ? meta["featureId"] : undefined;
    const featureId =
      typeof cliFeatureId === "string" ? cliFeatureId : metaFeatureId;
    if (typeof name === "string" && isRecord(inputSchema)) {
      listings.push({
        name,
        ...(typeof featureId === "string" ? { featureId } : {}),
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

export const requiresFeatureAccessRefresh = (
  tree: RouteNode = generatedRouteMap,
): boolean => hasFeatureCommands(tree);

/** Validated caller projection held only during its authenticated invocation. */
export type CurrentRegistry = {
  serverOrigin: string;
  listings: readonly RegistryToolListing[];
  delta: RegistryDelta;
  toolsListHash: string;
  grantedScopes?: readonly string[];
  scopeOmittedTools?: readonly string[];
  featureOmittedTools?: readonly string[];
  featureOmittedCapabilities?: readonly string[];
};

export type ResolvedCommandTree = {
  tree: RouteNode;
  /**
   * What diverged from the baked-in tree, when anything did. Reporting is
   * `registry-drift.ts`'s job: this path takes no network and writes no disk,
   * so it states the fact and leaves who-hears-about-it to the shell.
   */
  drift?: RegistryDelta;
  /** Commands the server attested are gated off in this deployment. */
  disabled: DisabledCommands;
};

/**
 * Resolve this invocation without network. A current same-origin response can
 * rebuild and prune the tree by caller scope; disk supplies deployment metadata
 * only. Caller feature admission projects the resolved tree using only the
 * current response; missing or invalid live data hides feature commands.
 */
export const resolveCommandTree = async ({
  serverOrigin,
  env,
  registry,
  featureAccess,
  bakedTree = generatedRouteMap,
  loadCatalog = loadBakedCapabilityCatalog,
  annotations = TOOL_ANNOTATIONS,
}: {
  serverOrigin: string | undefined;
  env: CacheEnv;
  registry?: CurrentRegistry;
  featureAccess?: CallerFeatureAccess;
  bakedTree?: RouteNode;
  loadCatalog?: () =>
    | readonly CapabilityCatalogEntry[]
    | null
    | Promise<readonly CapabilityCatalogEntry[] | null>;
  annotations?: Readonly<Record<string, ToolAnnotation>>;
}): Promise<ResolvedCommandTree> => {
  const file =
    serverOrigin !== undefined && registry?.serverOrigin === serverOrigin
      ? registry
      : undefined;
  const currentAccess = file === undefined ? undefined : featureAccess;
  const project = (tree: RouteNode) =>
    projectFeatureCommands({ tree, featureAccess: currentAccess });
  if (serverOrigin === undefined) {
    return {
      tree: project(bakedTree),
      disabled: NO_DISABLED_COMMANDS,
    };
  }
  const cached = await readCacheFile(cachePathFor(serverOrigin, env));
  const deployment = cached?.serverOrigin === serverOrigin ? cached : undefined;
  if (file === undefined) {
    return {
      tree: project(bakedTree),
      disabled: {
        tools: deployment?.featureOmittedTools ?? [],
        capabilities: deployment?.featureOmittedCapabilities ?? [],
      },
    };
  }
  // Tools and capabilities the server attested it omits because a deployment
  // feature is off. They stay in the tree (the server answers a call with its
  // own feature_disabled), and help/tools list mark them so nobody has to try.
  const disabled: DisabledCommands = {
    tools: file.featureOmittedTools ?? [],
    capabilities: file.featureOmittedCapabilities ?? [],
  };
  const prunedByScope = (file.scopeOmittedTools ?? []).some(
    (name) => !isCompoundTool(name),
  );
  const featureListings = file.listings.some(
    (listing) => listing.featureId !== undefined,
  );
  const enabledTools = new Set(currentAccess?.tools);
  const hiddenTools = new Set(
    Object.entries(annotations).flatMap(([name, annotation]) =>
      annotation.featureId !== undefined && !enabledTools.has(name)
        ? [name]
        : [],
    ),
  );
  for (const listing of file.listings) {
    if (listing.featureId !== undefined && !enabledTools.has(listing.name)) {
      hiddenTools.add(listing.name);
    }
  }
  const delta: RegistryDelta = {
    added: file.delta.added.filter((name) => !hiddenTools.has(name)),
    removed: file.delta.removed.filter((name) => !hiddenTools.has(name)),
    changed: file.delta.changed.filter((name) => !hiddenTools.has(name)),
  };
  if (isDeltaEmpty(file.delta) && !prunedByScope && !featureListings) {
    return { tree: project(bakedTree), disabled };
  }
  // Rebuild through the SAME shared builder codegen uses (curated tools from
  // the current listings + the baked capability merge), so a diverged registry
  // never drops the generated capability leaves. A missing/corrupt catalog or
  // a tree that fails to build falls back to the baked-in tree (rule 6).
  const entries = await loadCatalog();
  if (entries === null) {
    return { tree: project(bakedTree), disabled };
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
        annotations,
        entries,
      }).tree,
  );
  if (Result.isError(built)) {
    return { tree: project(bakedTree), disabled };
  }
  return isDeltaEmpty(delta)
    ? { tree: project(built.value), disabled }
    : {
        tree: project(built.value),
        drift: delta,
        disabled,
      };
};

/** The outcome of a cache-refresh attempt (spec S5.3/S5.5 + addendum nudge). */
export type RefreshOutcome =
  | { status: "skipped"; reason: "no-cache" | "fresh" }
  | { status: "failed"; warning: string }
  | { status: "admission-refused"; refusal: CliActionAdmissionRefusal }
  | {
      status: "refreshed";
      deltaEmpty: boolean;
      nudge?: string;
      featureAccess?: CallerFeatureAccess;
      registry: CurrentRegistry;
    };

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
  now = Temporal.Now.instant().epochMilliseconds,
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
    if (raw.error.admission !== undefined) {
      return { status: "admission-refused", refusal: raw.error.admission };
    }
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

  const registry: CurrentRegistry = {
    serverOrigin,
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
    ...(raw.value.featureOmittedCapabilities === undefined
      ? {}
      : { featureOmittedCapabilities: raw.value.featureOmittedCapabilities }),
  };
  const file: RegistryCacheFile = {
    version: CACHE_SCHEMA_VERSION,
    serverOrigin,
    fetchedAt: Temporal.Instant.fromEpochMilliseconds(now).toString({
      fractionalSecondDigits: 3,
    }),
    ttlSeconds,
    ...(raw.value.featureOmittedTools === undefined
      ? {}
      : { featureOmittedTools: raw.value.featureOmittedTools }),
    ...(raw.value.featureOmittedCapabilities === undefined
      ? {}
      : { featureOmittedCapabilities: raw.value.featureOmittedCapabilities }),
    ...(lastNudgedVersion === undefined ? {} : { lastNudgedVersion }),
  };
  await writeCacheFile(filePath, file);
  return {
    status: "refreshed",
    registry,
    deltaEmpty: isDeltaEmpty(delta),
    ...(trust.featureAccess === undefined
      ? {}
      : { featureAccess: trust.featureAccess }),
    ...(nudge.line === undefined ? {} : { nudge: nudge.line }),
  };
};
