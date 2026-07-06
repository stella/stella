import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  cacheDir,
  cachePathFor,
  computeDelta,
  DEFAULT_TTL_SECONDS,
  isCacheStale,
  isDeltaEmpty,
  originHash,
  readCacheFile,
  writeCacheFile,
  type RegistryCacheFile,
} from "./registry-cache.js";
import type { RegistryToolListing } from "./route-types.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

const listing = (
  name: string,
  properties: Record<string, unknown> = {},
): RegistryToolListing => ({
  name,
  description: "d",
  inputSchema: { type: "object", properties },
});

const cacheFile = (
  over: Partial<RegistryCacheFile> = {},
): RegistryCacheFile => ({
  version: 2,
  serverOrigin: "https://api.example.com",
  fetchedAt: new Date().toISOString(),
  ttlSeconds: DEFAULT_TTL_SECONDS,
  toolsListHash: "abc",
  listings: [listing("list_matters")],
  delta: { added: [], removed: [], changed: [] },
  ...over,
});

describe("cache paths (S5.3/S5.5 rule 5)", () => {
  test("XDG_CACHE_HOME wins and the file is one-per-origin", () => {
    const dir = cacheDir({ XDG_CACHE_HOME: "/x/cache", HOME: "/home/u" });
    expect(dir).toBe("/x/cache/stella/registry");
    const p = cachePathFor("https://a.example", {
      XDG_CACHE_HOME: "/x/cache",
    });
    expect(p).toBe(
      `/x/cache/stella/registry/${originHash("https://a.example")}.json`,
    );
  });

  test("falls back to ~/.cache when XDG_CACHE_HOME is unset", () => {
    expect(cacheDir({ HOME: "/home/u" })).toBe(
      "/home/u/.cache/stella/registry",
    );
  });

  test("distinct origins hash to distinct files (no cross-origin merge)", () => {
    expect(originHash("https://a.example")).not.toBe(
      originHash("https://b.example"),
    );
  });
});

describe("readCacheFile / writeCacheFile roundtrip", () => {
  test("writes then reads back an equivalent file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-cache-"));
    tempDirs.push(dir);
    const filePath = cachePathFor("https://api.example.com", {
      XDG_CACHE_HOME: dir,
    });
    const file = cacheFile();
    await writeCacheFile(filePath, file);
    const read = await readCacheFile(filePath);
    expect(read?.serverOrigin).toBe(file.serverOrigin);
    expect(read?.listings).toEqual(file.listings);
    expect(read?.delta).toEqual(file.delta);
  });

  test("preserves the lastNudgedVersion anti-nag key across a roundtrip", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-cache-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "n.json");
    await writeCacheFile(filePath, cacheFile({ lastNudgedVersion: "0.2.0" }));
    const read = await readCacheFile(filePath);
    expect(read?.lastNudgedVersion).toBe("0.2.0");
  });

  test("a missing file reads as undefined", async () => {
    const read = await readCacheFile("/nonexistent/stella/cache.json");
    expect(read).toBeUndefined();
  });

  test("a wrong-version file reads as undefined (invalidated)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-cache-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "v.json");
    await writeCacheFile(filePath, cacheFile({ version: 99 }));
    expect(await readCacheFile(filePath)).toBeUndefined();
  });

  test("a tampered listing entry drops the whole file (fail closed)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-cache-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "t.json");
    await Bun.write(
      filePath,
      JSON.stringify({
        ...cacheFile(),
        listings: [{ name: "x" /* missing inputSchema */ }],
      }),
    );
    expect(await readCacheFile(filePath)).toBeUndefined();
  });
});

describe("isCacheStale (TTL)", () => {
  test("fresh within TTL, stale past it", () => {
    const now = Date.parse("2026-01-02T00:00:00.000Z");
    const fresh = cacheFile({
      fetchedAt: new Date(now - 1000).toISOString(),
      ttlSeconds: 100,
    });
    expect(isCacheStale(fresh, now)).toBe(false);
    const stale = cacheFile({
      fetchedAt: new Date(now - 200_000).toISOString(),
      ttlSeconds: 100,
    });
    expect(isCacheStale(stale, now)).toBe(true);
  });

  test("an unparseable fetchedAt is treated as stale", () => {
    expect(
      isCacheStale(cacheFile({ fetchedAt: "not-a-date" }), Date.now()),
    ).toBe(true);
  });
});

describe("computeDelta / isDeltaEmpty (S5.3)", () => {
  test("identical registries produce an empty delta", () => {
    const baked = [listing("a"), listing("b")];
    const delta = computeDelta(baked, [listing("a"), listing("b")]);
    expect(isDeltaEmpty(delta)).toBe(true);
  });

  test("added, removed, and schema-changed tools are detected", () => {
    const baked = [listing("a", { x: { type: "string" } }), listing("gone")];
    const fetched = [
      listing("a", { x: { type: "integer" } }), // schema changed
      listing("added_tool"),
    ];
    const delta = computeDelta(baked, fetched);
    expect(delta.added).toEqual(["added_tool"]);
    expect(delta.removed).toEqual(["gone"]);
    expect(delta.changed).toEqual(["a"]);
    expect(isDeltaEmpty(delta)).toBe(false);
  });

  test("key re-ordering in a schema is not a change", () => {
    const baked = [
      {
        name: "a",
        description: "d",
        inputSchema: {
          type: "object",
          properties: { x: { type: "string" }, y: { type: "integer" } },
        },
      },
    ];
    const fetched = [
      {
        name: "a",
        description: "different",
        inputSchema: {
          type: "object",
          properties: { y: { type: "integer" }, x: { type: "string" } },
        },
      },
    ];
    expect(isDeltaEmpty(computeDelta(baked, fetched))).toBe(true);
  });
});
