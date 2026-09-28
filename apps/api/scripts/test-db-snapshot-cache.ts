import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SNAPSHOT_FORMAT = "1";
const LOCK_TIMEOUT_MS = 5 * 60_000;
const STALE_LOCK_MS = 30 * 60_000;
const POLL_MS = 250;
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_CACHE_ENTRIES = 4;

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? error.code : undefined;

const isCodeFile = (filePath: string) => /\.[cm]?[jt]sx?$/u.test(filePath);

export const snapshotInputPaths = (
  repositoryRoot: string,
  entryPoint: string,
): string[] => {
  const pending = [entryPoint];
  const visited = new Set<string>();
  const canonicalRoot = realpathSync(repositoryRoot);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (
      candidate === undefined ||
      !path.isAbsolute(candidate) ||
      candidate.split(path.sep).includes("node_modules")
    ) {
      continue;
    }
    const canonicalFile = realpathSync(candidate);
    if (!canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)) {
      continue;
    }
    const filePath = path.join(
      repositoryRoot,
      path.relative(canonicalRoot, canonicalFile),
    );
    if (visited.has(filePath)) {
      continue;
    }
    visited.add(filePath);
    if (!isCodeFile(filePath)) {
      continue;
    }
    const source = readFileSync(filePath, "utf-8").replace(/^#![^\n]*\n/u, "");
    for (const imported of transpiler.scanImports(source)) {
      const resolved = Bun.resolveSync(imported.path, path.dirname(filePath));
      pending.push(resolved);
    }
  }

  // pglite-schema.ts reads named migrations and scans the entire migration
  // directory for SQL statements. Hash the directory instead of mirroring
  // its current list of migration names.
  const migrationRoot = path.join(repositoryRoot, "apps/api/drizzle");
  if (statSync(migrationRoot, { throwIfNoEntry: false })?.isDirectory()) {
    const directories = [migrationRoot];
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory === undefined) {
        continue;
      }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(filePath);
        } else if (entry.isFile()) {
          visited.add(filePath);
        }
      }
    }
  }
  visited.add(path.join(repositoryRoot, "bun.lock"));
  return [...visited].toSorted();
};

export const snapshotKey = (repositoryRoot: string, entryPoint: string) => {
  const hash = createHash("sha256");
  hash.update(SNAPSHOT_FORMAT);
  hash.update("\0");
  hash.update(Bun.version);
  for (const filePath of snapshotInputPaths(repositoryRoot, entryPoint)) {
    hash.update("\0");
    hash.update(path.relative(repositoryRoot, filePath));
    hash.update("\0");
    hash.update(readFileSync(filePath));
  }
  return hash.digest("hex");
};

export const snapshotCacheDir = (env: NodeJS.ProcessEnv) =>
  env.STELLA_PGLITE_SNAPSHOT_CACHE_DIR ??
  path.join(
    env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"),
    "stella/pglite",
  );

export const snapshotDigest = async (filePath: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

type SnapshotLease = { path: string; release: () => void };
type CacheResult =
  | { status: "hit"; snapshot: SnapshotLease }
  | { status: "fallback"; reason: string };

type AcquireOptions = {
  cacheDir: string;
  key: string;
  build: (filePath: string) => Promise<void>;
  validate: (filePath: string) => Promise<boolean>;
  timeoutMs?: number;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
};

const stale = (lockDir: string) => {
  const age = Date.now() - statSync(lockDir).mtimeMs;
  if (age > STALE_LOCK_MS) {
    return true;
  }
  try {
    const owner: unknown = JSON.parse(
      readFileSync(path.join(lockDir, "owner"), "utf-8"),
    );
    return (
      typeof owner === "object" &&
      owner !== null &&
      "pid" in owner &&
      typeof owner.pid === "number" &&
      !alive(owner.pid)
    );
  } catch {
    return false; // mkdir may have completed before its owner was written.
  }
};

const releaseLock = (lockDir: string, token: string) => {
  try {
    const owner: unknown = JSON.parse(
      readFileSync(path.join(lockDir, "owner"), "utf-8"),
    );
    if (
      typeof owner === "object" &&
      owner !== null &&
      "token" in owner &&
      owner.token === token
    ) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // Another process may have taken over an expired lock.
  }
};

const leaseSnapshot = (
  cacheDir: string,
  key: string,
  filePath: string,
): SnapshotLease => {
  const leaseDir = path.join(cacheDir, `${key}.leases`);
  mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
  utimesSync(filePath, new Date(), new Date());
  const leasePath = path.join(leaseDir, `${process.pid}-${Bun.randomUUIDv7()}`);
  writeFileSync(leasePath, "", { mode: 0o600 });
  return {
    path: filePath,
    release: () => {
      try {
        rmSync(leasePath, { force: true });
      } catch {
        // Exit cleanup must not mask the test runner's result.
      }
    },
  };
};

const prune = (cacheDir: string, currentKey: string) => {
  try {
    const entries = readdirSync(cacheDir)
      .filter((name) => /^[a-f0-9]{64}\.tar$/u.test(name))
      .map((name) => ({
        name,
        modified: statSync(path.join(cacheDir, name)).mtimeMs,
      }))
      .toSorted((a, b) => b.modified - a.modified);
    for (const [index, entry] of entries.entries()) {
      if (
        index < MAX_CACHE_ENTRIES &&
        Date.now() - entry.modified < MAX_CACHE_AGE_MS
      ) {
        continue;
      }
      const key = entry.name.slice(0, -4);
      if (key === currentKey) {
        continue;
      }
      const lockDir = path.join(cacheDir, `${key}.lock`);
      try {
        mkdirSync(lockDir);
      } catch {
        continue;
      }
      const token = Bun.randomUUIDv7();
      try {
        writeFileSync(
          path.join(lockDir, "owner"),
          JSON.stringify({ pid: process.pid, token }),
          { mode: 0o600 },
        );
        const leaseDir = path.join(cacheDir, `${key}.leases`);
        const leases = statSync(leaseDir, { throwIfNoEntry: false })
          ? readdirSync(leaseDir)
          : [];
        for (const lease of leases) {
          const pid = Number(lease.split("-").at(0));
          if (!Number.isInteger(pid) || !alive(pid)) {
            rmSync(path.join(leaseDir, lease), { force: true });
          }
        }
        if (
          statSync(leaseDir, { throwIfNoEntry: false }) &&
          readdirSync(leaseDir).length > 0
        ) {
          continue;
        }
        rmSync(path.join(cacheDir, entry.name), { force: true });
        rmSync(path.join(cacheDir, `${key}.sha256`), { force: true });
        rmSync(leaseDir, { recursive: true, force: true });
      } finally {
        releaseLock(lockDir, token);
      }
    }
  } catch {
    // Pruning is optional; a failed prune must not affect a usable snapshot.
  }
};

export const acquireCachedSnapshot = async ({
  cacheDir,
  key,
  build,
  validate,
  timeoutMs = LOCK_TIMEOUT_MS,
}: AcquireOptions): Promise<CacheResult> => {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    accessSync(cacheDir, constants.W_OK);
  } catch (error) {
    return {
      status: "fallback",
      reason: `cache directory unavailable: ${String(error)}`,
    };
  }
  const finalPath = path.join(cacheDir, `${key}.tar`);
  const lockDir = path.join(cacheDir, `${key}.lock`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = Bun.randomUUIDv7();
    try {
      mkdirSync(lockDir, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        return {
          status: "fallback",
          reason: `cache lock unavailable: ${String(error)}`,
        };
      }
      try {
        if (stale(lockDir)) {
          const takeoverDir = `${lockDir}.takeover`;
          try {
            mkdirSync(takeoverDir, { mode: 0o700 });
          } catch {
            await Bun.sleep(POLL_MS);
            continue;
          }
          try {
            // Recheck under the takeover lock: another waiter may already
            // have replaced the stale owner with a live builder.
            if (stale(lockDir)) {
              const oldLockDir = `${lockDir}.stale-${Bun.randomUUIDv7()}`;
              renameSync(lockDir, oldLockDir);
              rmSync(oldLockDir, { recursive: true, force: true });
            }
          } finally {
            rmSync(takeoverDir, { recursive: true, force: true });
          }
          continue;
        }
      } catch {
        // Another process may have released or replaced the lock.
      }
      await Bun.sleep(POLL_MS);
      continue;
    }
    try {
      writeFileSync(
        path.join(lockDir, "owner"),
        JSON.stringify({ pid: process.pid, started: Date.now(), token }),
        { mode: 0o600 },
      );
      if (statSync(finalPath, { throwIfNoEntry: false })) {
        let valid = false;
        try {
          valid = await validate(finalPath);
        } catch {
          // Treat an unreadable entry exactly like a corrupt one.
        }
        if (!valid) {
          return {
            status: "fallback",
            reason: "cached snapshot is unreadable or corrupt",
          };
        }
        return {
          status: "hit",
          snapshot: leaseSnapshot(cacheDir, key, finalPath),
        };
      }
      const temporaryPath = `${finalPath}.tmp-${process.pid}-${token}`;
      const digestPath = path.join(cacheDir, `${key}.sha256`);
      const temporaryDigestPath = `${digestPath}.tmp-${process.pid}-${token}`;
      try {
        await build(temporaryPath);
        writeFileSync(
          temporaryDigestPath,
          await snapshotDigest(temporaryPath),
          {
            mode: 0o600,
          },
        );
        renameSync(temporaryDigestPath, digestPath);
        renameSync(temporaryPath, finalPath);
      } finally {
        rmSync(temporaryPath, { force: true });
        rmSync(temporaryDigestPath, { force: true });
      }
      if (!(await validate(finalPath))) {
        return {
          status: "fallback",
          reason: "built snapshot is unreadable or corrupt",
        };
      }
      const snapshot = leaseSnapshot(cacheDir, key, finalPath);
      prune(cacheDir, key);
      return { status: "hit", snapshot };
    } catch (error) {
      return {
        status: "fallback",
        reason: `cache write failed: ${String(error)}`,
      };
    } finally {
      releaseLock(lockDir, token);
    }
  }
  return { status: "fallback", reason: "cache lock timed out" };
};
