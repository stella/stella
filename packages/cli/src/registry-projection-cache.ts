import { Result } from "better-result";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import { decodeAccessTokenClaims } from "./auth/jwt.js";
import type { RawToolsList } from "./mcp-client.js";
import {
  MAX_LISTING_BYTES,
  validateFetchedToolsList,
} from "./registry-trust.js";
import { sha256Hex } from "./sha256.js";

/** Short-lived caller projections are never shared between credential generations. */
export const PROJECTION_TTL_MS = 30_000;
const MAX_CACHE_BYTES = MAX_LISTING_BYTES + 64 * 1024;
const names = v.exactOptional(v.array(v.string()));
const cacheSchema = v.strictObject({
  version: v.literal(1),
  fetchedAt: v.number(),
  raw: v.strictObject({
    rawBody: v.string(),
    cliMinimum: v.exactOptional(v.string()),
    cliLatest: v.exactOptional(v.string()),
    grantedScopes: names,
    scopeOmittedTools: names,
    featureOmittedTools: names,
    featureOmittedCapabilities: names,
  }),
});

type ProjectionCacheKey = {
  configDir: string;
  serverOrigin: string;
  token: string;
  currentVersion: string;
};

export const projectionCachePath = ({
  configDir,
  serverOrigin,
  token,
  currentVersion,
}: ProjectionCacheKey): string => {
  const organization = decodeAccessTokenClaims(token)?.org_id;
  const key = sha256Hex(
    [
      sha256Hex(serverOrigin),
      sha256Hex(organization ?? ""),
      sha256Hex(currentVersion),
      sha256Hex(token),
    ].join(":"),
  );
  return path.join(configDir, "registry", `${key}.json`);
};

export type ProjectionCacheRead =
  | { status: "hit"; raw: RawToolsList }
  | { status: "miss" }
  | { status: "invalid" }
  | { status: "unreadable"; cause: unknown };

export const readProjectionCache = async (
  filePath: string,
  now: number,
): Promise<ProjectionCacheRead> => {
  const read = await Result.tryPromise(
    async () => await readFile(filePath, "utf-8"),
  );
  if (read.isErr()) {
    return { status: "unreadable", cause: read.error };
  }
  if (Buffer.byteLength(read.value) > MAX_CACHE_BYTES) {
    return { status: "invalid" };
  }
  const parsed = Result.try((): unknown => JSON.parse(read.value));
  if (parsed.isErr()) {
    return { status: "invalid" };
  }
  const cache = v.safeParse(cacheSchema, parsed.value);
  if (!cache.success) {
    return { status: "invalid" };
  }
  if (
    now < cache.output.fetchedAt ||
    now - cache.output.fetchedAt >= PROJECTION_TTL_MS
  ) {
    return { status: "miss" };
  }
  return validateFetchedToolsList(cache.output.raw.rawBody).ok
    ? { status: "hit", raw: cache.output.raw }
    : { status: "invalid" };
};

type WriteProjectionCacheOptions = {
  filePath: string;
  raw: RawToolsList;
  now: number;
};

export const writeProjectionCache = async ({
  filePath,
  raw,
  now,
}: WriteProjectionCacheOptions): Promise<Result<void, unknown>> => {
  const temp = `${filePath}.${randomUUID()}.tmp`;
  const written = await Result.tryPromise(async () => {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(temp, JSON.stringify({ version: 1, fetchedAt: now, raw }), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, filePath);
  });
  if (written.isErr()) {
    const cleanup = await Result.tryPromise(
      async () => await rm(temp, { force: true }),
    );
    if (cleanup.isErr()) {
      return Result.err(cleanup.error);
    }
  }
  return written;
};
