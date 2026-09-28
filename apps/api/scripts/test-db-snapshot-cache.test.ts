import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  acquireCachedSnapshot,
  snapshotInputPaths,
  snapshotKey,
} from "./test-db-snapshot-cache";

const temporaryRoots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-snapshot-cache-test-"));
  temporaryRoots.push(root);
  writeFileSync(path.join(root, "bun.lock"), "lock-v1");
  writeFileSync(
    path.join(root, "entry.ts"),
    'import "./schema"; await import("./dynamic");',
  );
  writeFileSync(path.join(root, "schema.ts"), "export const schema = 1;");
  writeFileSync(path.join(root, "dynamic.ts"), "export const dynamic = 1;");
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("key tracks the import closure, lockfile, and remains stable without changes", () => {
  const root = fixture();
  const entry = path.join(root, "entry.ts");
  const inputs = snapshotInputPaths(root, entry);
  expect(inputs).toContain(path.join(root, "schema.ts"));
  expect(inputs).toContain(path.join(root, "dynamic.ts"));
  const first = snapshotKey(root, entry);
  expect(snapshotKey(root, entry)).toBe(first);
  writeFileSync(path.join(root, "schema.ts"), "export const schema = 2;");
  const schemaChange = snapshotKey(root, entry);
  expect(schemaChange).not.toBe(first);
  writeFileSync(path.join(root, "bun.lock"), "lock-v2");
  const lockChange = snapshotKey(root, entry);
  expect(lockChange).not.toBe(schemaChange);
  const migrationDir = path.join(root, "apps/api/drizzle/next");
  mkdirSync(migrationDir, { recursive: true });
  writeFileSync(path.join(migrationDir, "migration.sql"), "SELECT 1;");
  expect(snapshotKey(root, entry)).not.toBe(lockChange);
});

test("real snapshot closure contains schema modules and migration SQL", () => {
  const root = path.resolve(import.meta.dir, "../../..");
  const inputs = snapshotInputPaths(
    root,
    path.join(import.meta.dir, "build-pglite-snapshot.ts"),
  );
  expect(inputs).toContain(path.join(root, "apps/api/src/db/schema.ts"));
  expect(inputs).toContain(
    path.join(root, "apps/api/src/tests/pglite-schema.ts"),
  );
  expect(inputs.some((file) => file.endsWith("/migration.sql"))).toBe(true);
});

test("concurrent acquirers build once and both receive the final snapshot", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  let builds = 0;
  const acquire = () =>
    acquireCachedSnapshot({
      cacheDir,
      key: "a".repeat(64),
      build: async (filePath) => {
        builds += 1;
        await Bun.sleep(100);
        writeFileSync(filePath, "valid");
      },
      validate: async (filePath) => readFileSync(filePath, "utf-8") === "valid",
    });
  const [first, second] = await Promise.all([acquire(), acquire()]);
  expect(builds).toBe(1);
  expect(first.status).toBe("hit");
  expect(second.status).toBe("hit");
  if (first.status === "hit" && second.status === "hit") {
    expect(first.snapshot.path).toBe(second.snapshot.path);
    first.snapshot.release();
    second.snapshot.release();
  }
});

test("dead-owner lock is taken over", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  const key = "b".repeat(64);
  const lockDir = path.join(cacheDir, `${key}.lock`);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    path.join(lockDir, "owner"),
    JSON.stringify({ pid: 99_999_999, started: 0, token: "dead" }),
  );
  const result = await acquireCachedSnapshot({
    cacheDir,
    key,
    build: async (filePath) => {
      writeFileSync(filePath, "valid");
    },
    validate: async () => true,
    timeoutMs: 2000,
  });
  expect(result.status).toBe("hit");
  if (result.status === "hit") {
    result.snapshot.release();
  }
});

test("competing stale-lock takers still build once", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  const key = "f".repeat(64);
  const lockDir = path.join(cacheDir, `${key}.lock`);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    path.join(lockDir, "owner"),
    JSON.stringify({ pid: 99_999_999, started: 0, token: "dead" }),
  );
  let builds = 0;
  const acquire = () =>
    acquireCachedSnapshot({
      cacheDir,
      key,
      build: async (filePath) => {
        builds += 1;
        await Bun.sleep(100);
        writeFileSync(filePath, "valid");
      },
      validate: async () => true,
    });
  const results = await Promise.all([acquire(), acquire()]);
  expect(builds).toBe(1);
  for (const result of results) {
    expect(result.status).toBe("hit");
    if (result.status === "hit") {
      result.snapshot.release();
    }
  }
});

test("old lock is taken over even when its pid is live", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  const key = "c".repeat(64);
  const lockDir = path.join(cacheDir, `${key}.lock`);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    path.join(lockDir, "owner"),
    JSON.stringify({ pid: process.pid, started: 0, token: "old" }),
  );
  const old = new Date(0);
  utimesSync(lockDir, old, old);
  const result = await acquireCachedSnapshot({
    cacheDir,
    key,
    build: async (filePath) => {
      writeFileSync(filePath, "valid");
    },
    validate: async () => true,
    timeoutMs: 2000,
  });
  expect(result.status).toBe("hit");
  if (result.status === "hit") {
    result.snapshot.release();
  }
});

test("corrupt cache entry falls back without deleting it", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  const key = "d".repeat(64);
  mkdirSync(cacheDir);
  const finalPath = path.join(cacheDir, `${key}.tar`);
  writeFileSync(finalPath, "corrupt");
  let built = false;
  const result = await acquireCachedSnapshot({
    cacheDir,
    key,
    build: async () => {
      built = true;
    },
    validate: async () => false,
  });
  expect(result).toEqual({
    status: "fallback",
    reason: "cached snapshot is unreadable or corrupt",
  });
  expect(built).toBe(false);
  expect(readFileSync(finalPath, "utf-8")).toBe("corrupt");
});

test("unwritable cache location falls back", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "not-a-directory");
  writeFileSync(cacheDir, "");
  let built = false;
  const result = await acquireCachedSnapshot({
    cacheDir,
    key: "e".repeat(64),
    build: async () => {
      built = true;
    },
    validate: async () => true,
  });
  expect(result.status).toBe("fallback");
  expect(built).toBe(false);
});

test("pruning preserves a snapshot leased by another test run", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  const acquire = (key: string) =>
    acquireCachedSnapshot({
      cacheDir,
      key,
      build: async (filePath) => {
        writeFileSync(filePath, "valid");
      },
      validate: async () => true,
    });
  const firstKey = "1".repeat(64);
  const first = await acquire(firstKey);
  expect(first.status).toBe("hit");
  for (const digit of ["2", "3", "4", "5"]) {
    const result = await acquire(digit.repeat(64));
    expect(result.status).toBe("hit");
    if (result.status === "hit") {
      result.snapshot.release();
    }
  }
  expect(existsSync(path.join(cacheDir, `${firstKey}.tar`))).toBe(true);
  if (first.status === "hit") {
    first.snapshot.release();
  }
  const sixth = await acquire("6".repeat(64));
  expect(sixth.status).toBe("hit");
  if (sixth.status === "hit") {
    sixth.snapshot.release();
  }
  expect(existsSync(path.join(cacheDir, `${firstKey}.tar`))).toBe(false);
});
