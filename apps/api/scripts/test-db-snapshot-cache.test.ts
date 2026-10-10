import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import {
  acquireCachedSnapshot,
  acquireCurrentSnapshot,
  snapshotDigest,
  snapshotInputPaths,
  snapshotKey,
  SnapshotBuildError,
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
  expect(inputs.some((file) => path.basename(file) === "migration.sql")).toBe(
    true,
  );
  for (const dependency of ["drizzle-kit", "drizzle-orm", "pglite"]) {
    expect(
      inputs.some(
        (file) => file.includes("node_modules") && file.includes(dependency),
      ),
    ).toBe(true);
  }
});

test("patch contents invalidate the key without a lockfile change", () => {
  const root = fixture();
  const entry = path.join(root, "entry.ts");
  const patchDir = path.join(root, "patches");
  mkdirSync(patchDir);
  const patch = path.join(patchDir, "drizzle-kit.patch");
  writeFileSync(patch, "old DDL");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      patchedDependencies: { "drizzle-kit@1": "patches/drizzle-kit.patch" },
    }),
  );
  const before = snapshotKey(root, entry);
  writeFileSync(patch, "new DDL");
  expect(snapshotKey(root, entry)).not.toBe(before);
  expect(readFileSync(path.join(root, "bun.lock"), "utf-8")).toBe("lock-v1");
});

test("installed dependency version invalidates the key with identical source and lockfile", () => {
  const createInstall = (version: string) => {
    const root = fixture();
    writeFileSync(path.join(root, "entry.ts"), 'import "example";');
    const packageDir = path.join(
      root,
      "node_modules/.bun",
      `example@${version}`,
      "node_modules/example",
    );
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(packageDir, "package.json"),
      '{"name":"example","version":"1.0.0","exports":"./index.js"}',
    );
    writeFileSync(path.join(packageDir, "index.js"), "export const value = 1;");
    symlinkSync(
      repoRelativePath(path.join(root, "node_modules"), packageDir),
      path.join(root, "node_modules/example"),
    );
    return root;
  };
  const oldRoot = createInstall("1");
  const sameRoot = createInstall("1");
  const newRoot = createInstall("2");
  const oldInputs = snapshotInputPaths(oldRoot, path.join(oldRoot, "entry.ts"));
  expect(oldInputs.some((file) => file.includes("example@1"))).toBe(true);
  expect(snapshotKey(oldRoot, path.join(oldRoot, "entry.ts"))).toBe(
    snapshotKey(sameRoot, path.join(sameRoot, "entry.ts")),
  );
  expect(snapshotKey(oldRoot, path.join(oldRoot, "entry.ts"))).not.toBe(
    snapshotKey(newRoot, path.join(newRoot, "entry.ts")),
  );
});

test("concurrent acquirers build once and both receive the final snapshot", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  let builds = 0;
  const acquire = async () =>
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

test("a changed key during build discards the old output and retries", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  const oldKey = "a".repeat(64);
  const newKey = "b".repeat(64);
  let currentKey = oldKey;
  let builds = 0;
  const result = await acquireCurrentSnapshot({
    cacheDir,
    key: () => currentKey,
    build: async (filePath) => {
      builds += 1;
      writeFileSync(filePath, "valid");
      if (builds === 1) {
        currentKey = newKey;
      }
    },
    validate: async () => true,
  });
  expect(result.status).toBe("hit");
  if (result.status === "hit") {
    expect(result.snapshot.path).toBe(path.join(cacheDir, `${newKey}.tar`));
    result.snapshot.release();
  }
  expect(builds).toBe(2);
  expect(existsSync(path.join(cacheDir, `${oldKey}.tar`))).toBe(false);
});

test("a changed key while waiting does not accept the old snapshot", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  const oldKey = "c".repeat(64);
  const newKey = "d".repeat(64);
  const lockDir = path.join(cacheDir, `${oldKey}.lock`);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    path.join(lockDir, "owner"),
    JSON.stringify({ pid: process.pid, started: Date.now(), token: "owner" }),
  );
  writeFileSync(path.join(cacheDir, `${oldKey}.tar`), "old");
  let currentKey = oldKey;
  const change = setTimeout(() => {
    currentKey = newKey;
    rmSync(lockDir, { recursive: true, force: true });
  }, 20);
  let builds = 0;
  try {
    const result = await acquireCurrentSnapshot({
      cacheDir,
      key: () => currentKey,
      build: async (filePath) => {
        builds += 1;
        writeFileSync(filePath, "new");
      },
      validate: async () => true,
    });
    expect(result.status).toBe("hit");
    if (result.status === "hit") {
      expect(result.snapshot.path).toBe(path.join(cacheDir, `${newKey}.tar`));
      result.snapshot.release();
    }
    expect(builds).toBe(1);
  } finally {
    clearTimeout(change);
  }
});

test("abort stops a cache-lock wait promptly", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  const key = "e".repeat(64);
  const lockDir = path.join(cacheDir, `${key}.lock`);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    path.join(lockDir, "owner"),
    JSON.stringify({ pid: process.pid, started: Date.now(), token: "owner" }),
  );
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  let builds = 0;
  try {
    const rejection = await acquireCachedSnapshot({
      cacheDir,
      key,
      build: async (filePath) => {
        builds += 1;
        writeFileSync(filePath, "unexpected");
      },
      validate: async () => true,
      signal: controller.signal,
      timeoutMs: 5000,
    }).then(
      () => {
        throw new Error("Expected snapshot acquisition to reject");
      },
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(SnapshotBuildError);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(builds).toBe(0);
  } finally {
    clearTimeout(abort);
  }
});

test("abort during cached validation preserves the archive and digest", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  mkdirSync(cacheDir);
  for (const behavior of ["false", "throws"] as const) {
    const key = behavior === "false" ? "a".repeat(64) : "c".repeat(64);
    const finalPath = path.join(cacheDir, `${key}.tar`);
    const digestPath = path.join(cacheDir, `${key}.sha256`);
    writeFileSync(finalPath, `valid cached snapshot ${behavior}`);
    const digest = await snapshotDigest(finalPath);
    writeFileSync(digestPath, digest);
    const controller = new AbortController();
    const rejection = await acquireCachedSnapshot({
      cacheDir,
      key,
      build: async () => {
        throw new Error("A cached snapshot must not be rebuilt");
      },
      validate: async () => {
        controller.abort();
        if (behavior === "throws") {
          throw new Error("snapshot validation interrupted");
        }
        return false;
      },
      signal: controller.signal,
    }).then(
      () => {
        throw new Error("Expected snapshot acquisition to reject");
      },
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(SnapshotBuildError);
    expect(readFileSync(finalPath, "utf-8")).toBe(
      `valid cached snapshot ${behavior}`,
    );
    expect(readFileSync(digestPath, "utf-8")).toBe(digest);
  }
});

test("abort during built snapshot validation propagates for false and throws", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  for (const behavior of ["false", "throws"] as const) {
    const key = behavior === "false" ? "b".repeat(64) : "d".repeat(64);
    const controller = new AbortController();
    const rejection = await acquireCachedSnapshot({
      cacheDir,
      key,
      build: async (filePath) => {
        writeFileSync(filePath, `new snapshot ${behavior}`);
      },
      validate: async () => {
        controller.abort();
        if (behavior === "throws") {
          throw new Error("snapshot validation interrupted");
        }
        return false;
      },
      signal: controller.signal,
    }).then(
      () => {
        throw new Error("Expected snapshot acquisition to reject");
      },
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(SnapshotBuildError);
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
  const acquire = async () =>
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

test("corrupt cache entry is rebuilt in place", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  const key = "d".repeat(64);
  mkdirSync(cacheDir);
  const finalPath = path.join(cacheDir, `${key}.tar`);
  writeFileSync(finalPath, "corrupt");
  let builds = 0;
  const result = await acquireCachedSnapshot({
    cacheDir,
    key,
    build: async (filePath) => {
      builds += 1;
      writeFileSync(filePath, "valid");
    },
    validate: async (filePath) => readFileSync(filePath, "utf-8") === "valid",
  });
  expect(result.status).toBe("hit");
  if (result.status === "hit") {
    result.snapshot.release();
  }
  expect(builds).toBe(1);
  expect(readFileSync(finalPath, "utf-8")).toBe("valid");
  expect(existsSync(path.join(cacheDir, `${key}.sha256`))).toBe(true);
});

test("builder failure cleans partial output and pruning removes old temp files", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  const failedKey = "7".repeat(64);
  const rejection = await acquireCachedSnapshot({
    cacheDir,
    key: failedKey,
    build: async (filePath) => {
      writeFileSync(filePath, "partial");
      throw new SnapshotBuildError({
        message: "builder failed",
        exitCode: 1,
      });
    },
    validate: async () => true,
  }).then(
    () => {
      throw new Error("Expected snapshot acquisition to reject");
    },
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(SnapshotBuildError);
  expect(readdirSync(cacheDir).some((name) => name.includes(".tmp-"))).toBe(
    false,
  );

  const oldTar = path.join(cacheDir, `${failedKey}.tar.tmp-orphan`);
  const oldDigest = path.join(cacheDir, `${failedKey}.sha256.tmp-orphan`);
  for (const filePath of [oldTar, oldDigest]) {
    writeFileSync(filePath, "partial");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(filePath, old, old);
  }
  const result = await acquireCachedSnapshot({
    cacheDir,
    key: "8".repeat(64),
    build: async (filePath) => {
      writeFileSync(filePath, "valid");
    },
    validate: async () => true,
  });
  expect(result.status).toBe("hit");
  if (result.status === "hit") {
    result.snapshot.release();
  }
  expect(existsSync(oldTar)).toBe(false);
  expect(existsSync(oldDigest)).toBe(false);
});

test("old takeover directory is removed before stale-lock takeover", async () => {
  const root = fixture();
  const cacheDir = path.join(root, "cache");
  const key = "9".repeat(64);
  const lockDir = path.join(cacheDir, `${key}.lock`);
  const takeoverDir = `${lockDir}.takeover`;
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    path.join(lockDir, "owner"),
    JSON.stringify({ pid: 99_999_999, started: 0, token: "dead" }),
  );
  mkdirSync(takeoverDir);
  const old = new Date(Date.now() - 20_000);
  utimesSync(takeoverDir, old, old);
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
  expect(existsSync(takeoverDir)).toBe(false);
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
  const acquire = async (key: string) =>
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
