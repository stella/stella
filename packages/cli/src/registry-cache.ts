// The per-origin XDG registry cache (spec 051 S5.3). One file per server origin
// under `$XDG_CACHE_HOME/stella/registry/<origin-hash>.json` (`~/.cache/...`
// fallback). The cache lets a `tools/list` fetched once (at `auth login` or on a
// TTL refresh) drive the command tree offline until it goes stale, and records
// the delta vs the baked-in tree so a divergence can be surfaced on stderr.
//
// This module is I/O-bounded (reads/writes the cache file); pure helpers
// (`computeDelta`, `isCacheStale`, `isDeltaEmpty`) are exported for the runtime
// path and its tests. It stores no secrets: only public tool listings.

import { Result } from "better-result";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type StableStringifyInput,
  stableStringify,
} from "@stll/stable-stringify";

import type { JsonSchema, RegistryToolListing } from "./route-types.js";

// Cache schema version; a bump invalidates every existing cache file. Version 4
// invalidates deltas computed before feature-omission evidence existed, which
// counted a deployment-gated tool as removed on every refresh.
export const CACHE_SCHEMA_VERSION = 4;
/** Default time-to-live before a cached listing is refetched (spec S5.3). */
export const DEFAULT_TTL_SECONDS = 86_400;

/** The delta of a fetched registry vs the baked-in tree (spec S5.3). */
export type RegistryDelta = {
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
};

/** The on-disk cache file shape (spec S5.3). */
export type RegistryCacheFile = {
  version: number;
  serverOrigin: string;
  fetchedAt: string;
  ttlSeconds: number;
  toolsListHash: string;
  listings: readonly RegistryToolListing[];
  delta: RegistryDelta;
  /** Effective grants for the response, absent when the server did not attest them. */
  grantedScopes?: readonly string[];
  /** Tool names the server attested were omitted solely for missing scope. */
  scopeOmittedTools?: readonly string[];
  /** Tool names the server attested are gated off in this deployment. */
  featureOmittedTools?: readonly string[];
  /** The latest CLI version we last nudged about (update-nudge anti-nag key). */
  lastNudgedVersion?: string;
};

/** The environment slice the cache directory resolution needs. */
export type CacheEnv = {
  XDG_CACHE_HOME?: string | undefined;
  HOME?: string | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `stella/registry` cache directory (XDG, `~/.cache` fallback; spec S5.3). */
export const cacheDir = (env: CacheEnv): string => {
  const base =
    env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0
      ? env.XDG_CACHE_HOME
      : path.join(env.HOME ?? ".", ".cache");
  return path.join(base, "stella", "registry");
};

/** A stable sha256 hex of the server origin, used as the cache filename. */
export const originHash = (serverOrigin: string): string =>
  createHash("sha256").update(serverOrigin).digest("hex");

/** The cache file path for a given origin (one file per origin; spec S5.5 rule 5). */
export const cachePathFor = (serverOrigin: string, env: CacheEnv): string =>
  path.join(cacheDir(env), `${originHash(serverOrigin)}.json`);

/** True when the cache is older than its TTL and should be refetched. */
export const isCacheStale = (
  file: RegistryCacheFile,
  nowMs: number,
): boolean => {
  const fetchedAtMs = Date.parse(file.fetchedAt);
  if (Number.isNaN(fetchedAtMs)) {
    return true;
  }
  return nowMs - fetchedAtMs > file.ttlSeconds * 1000;
};

/** True when a delta has no additions, removals, or changes. */
export const isDeltaEmpty = (delta: RegistryDelta): boolean =>
  delta.added.length === 0 &&
  delta.removed.length === 0 &&
  delta.changed.length === 0;

/**
 * A `JsonSchema` is parsed JSON, but its type (`Record<string, unknown>`) does
 * not say so and the fingerprint contract does. Restate the shape the wire
 * already guarantees. Anything outside it never reaches here; it reads as
 * `null` rather than serializing through its own keys and colliding with an
 * unrelated value.
 */
const toJsonValue = (value: unknown): StableStringifyInput => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => toJsonValue(item));
  }

  if (isRecord(value)) {
    const jsonObject: Record<string, StableStringifyInput> = {};
    for (const [key, nested] of Object.entries(value)) {
      jsonObject[key] = toJsonValue(nested);
    }
    return jsonObject;
  }

  return null;
};

/** A schema's fingerprint, so a re-ordered schema is not a "change". */
const schemaFingerprint = (schema: JsonSchema): string =>
  stableStringify(toJsonValue(schema));

/**
 * Diff fetched listings against the baked-in listings (spec S5.3): a tool is
 * `changed` when its `inputSchema` shape (which drives generated flags, incl.
 * `required[]`) differs. Descriptions and annotations do not count as changes.
 *
 * `omittedTools` carries the server's own attestation of what this projection
 * left out (missing scope, deployment feature flag). An attested name is not a
 * removal: the tool still exists on the server, so counting it would leave a
 * delta that no refresh can ever reconcile. The argument is required precisely
 * so no call site can diff against a projection without stating its omissions;
 * a server that attests nothing passes an empty list and keeps plain-diff
 * behaviour.
 */
export const computeDelta = ({
  baked,
  fetched,
  omittedTools,
}: {
  baked: readonly RegistryToolListing[];
  fetched: readonly RegistryToolListing[];
  omittedTools: readonly string[];
}): RegistryDelta => {
  const bakedByName = new Map(baked.map((tool) => [tool.name, tool]));
  const fetchedByName = new Map(fetched.map((tool) => [tool.name, tool]));
  const attestedOmissions = new Set(omittedTools);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const tool of fetched) {
    if (!bakedByName.has(tool.name)) {
      added.push(tool.name);
    }
  }
  for (const tool of baked) {
    if (!fetchedByName.has(tool.name) && !attestedOmissions.has(tool.name)) {
      removed.push(tool.name);
    }
  }
  for (const tool of fetched) {
    const bakedTool = bakedByName.get(tool.name);
    if (bakedTool === undefined) {
      continue;
    }
    if (
      schemaFingerprint(bakedTool.inputSchema) !==
      schemaFingerprint(tool.inputSchema)
    ) {
      changed.push(tool.name);
    }
  }

  return { added, removed, changed };
};

/**
 * Re-shape the cached `listings` on read (defense in depth for a locally-tampered
 * cache): keep only the wire fields, and drop the whole file if any entry is
 * malformed so the caller falls back to the baked-in tree.
 */
const parseListings = (value: unknown): RegistryToolListing[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const listings: RegistryToolListing[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry["name"] !== "string" ||
      typeof entry["description"] !== "string" ||
      !isRecord(entry["inputSchema"])
    ) {
      return undefined;
    }
    const listing: RegistryToolListing = {
      name: entry["name"],
      description: entry["description"],
      inputSchema: entry["inputSchema"],
    };
    const annotations = entry["annotations"];
    if (isRecord(annotations)) {
      const hints: { readOnlyHint?: boolean; destructiveHint?: boolean } = {};
      if (typeof annotations["readOnlyHint"] === "boolean") {
        hints.readOnlyHint = annotations["readOnlyHint"];
      }
      if (typeof annotations["destructiveHint"] === "boolean") {
        hints.destructiveHint = annotations["destructiveHint"];
      }
      listing.annotations = hints;
    }
    listings.push(listing);
  }
  return listings;
};

const parseDelta = (value: unknown): RegistryDelta | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const asStrings = (raw: unknown): string[] | undefined =>
    Array.isArray(raw) && raw.every((item) => typeof item === "string")
      ? raw
      : undefined;
  const added = asStrings(value["added"]);
  const removed = asStrings(value["removed"]);
  const changed = asStrings(value["changed"]);
  if (added === undefined || removed === undefined || changed === undefined) {
    return undefined;
  }
  return { added, removed, changed };
};

/**
 * An optional string-array field: absent (the server attested nothing), present,
 * or malformed. A malformed one drops the whole file, so a locally tampered
 * cache cannot pass a partly-validated field through to the runtime tree.
 */
type OptionalNames =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "present"; names: readonly string[] };

const parseOptionalNames = (value: unknown): OptionalNames => {
  if (value === undefined) {
    return { status: "absent" };
  }
  if (!Array.isArray(value)) {
    return { status: "invalid" };
  }
  const names: string[] = [];
  for (const name of value) {
    if (typeof name !== "string") {
      return { status: "invalid" };
    }
    names.push(name);
  }
  return { status: "present", names };
};

/**
 * Read and shape-validate the cache file for an origin. A missing, corrupt, or
 * wrong-version file returns `undefined` (the caller falls back to baked-in).
 */
export const readCacheFile = async (
  filePath: string,
): Promise<RegistryCacheFile | undefined> => {
  const parsed = await Result.tryPromise({
    try: async (): Promise<unknown> =>
      JSON.parse(await readFile(filePath, "utf-8")),
    catch: (cause) => cause,
  });
  if (Result.isError(parsed)) {
    return undefined;
  }
  const value = parsed.value;
  if (!isRecord(value) || value["version"] !== CACHE_SCHEMA_VERSION) {
    return undefined;
  }
  const serverOrigin = value["serverOrigin"];
  const fetchedAt = value["fetchedAt"];
  const ttlSeconds = value["ttlSeconds"];
  const toolsListHash = value["toolsListHash"];
  const listings = parseListings(value["listings"]);
  const delta = parseDelta(value["delta"]);
  if (
    typeof serverOrigin !== "string" ||
    typeof fetchedAt !== "string" ||
    typeof ttlSeconds !== "number" ||
    typeof toolsListHash !== "string" ||
    listings === undefined ||
    delta === undefined
  ) {
    return undefined;
  }
  const grantedScopes = parseOptionalNames(value["grantedScopes"]);
  const scopeOmittedTools = parseOptionalNames(value["scopeOmittedTools"]);
  const featureOmittedTools = parseOptionalNames(value["featureOmittedTools"]);
  if (
    grantedScopes.status === "invalid" ||
    scopeOmittedTools.status === "invalid" ||
    featureOmittedTools.status === "invalid"
  ) {
    return undefined;
  }
  const lastNudgedVersion = value["lastNudgedVersion"];
  return {
    version: CACHE_SCHEMA_VERSION,
    serverOrigin,
    fetchedAt,
    ttlSeconds,
    toolsListHash,
    listings,
    delta,
    ...(grantedScopes.status === "present"
      ? { grantedScopes: grantedScopes.names }
      : {}),
    ...(scopeOmittedTools.status === "present"
      ? { scopeOmittedTools: scopeOmittedTools.names }
      : {}),
    ...(featureOmittedTools.status === "present"
      ? { featureOmittedTools: featureOmittedTools.names }
      : {}),
    ...(typeof lastNudgedVersion === "string" ? { lastNudgedVersion } : {}),
  };
};

/** Write the cache file, creating the cache directory if needed. */
export const writeCacheFile = async (
  filePath: string,
  file: RegistryCacheFile,
): Promise<void> => {
  // `Bun.write` created missing parent directories implicitly; `node:fs`
  // `writeFile` does not, so mkdir the origin cache dir first (spec S5.3).
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`);
};
