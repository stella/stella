import { TaggedError } from "better-result";
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
import { setTimeout as sleep } from "node:timers/promises";

import { compareCodeUnit } from "@stll/collation";
import { createSha256 } from "@stll/sha256/bun";

const SNAPSHOT_FORMAT = "1";
const LOCK_TIMEOUT_MS = 5 * 60_000;
const STALE_LOCK_MS = 30 * 60_000;
const STALE_TAKEOVER_MS = 10_000;
const POLL_MS = 250;
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_TEMP_AGE_MS = 60 * 60_000;
const MAX_CACHE_ENTRIES = 4;
const MAX_INPUT_RETRIES = 3;

export class SnapshotBuildError extends TaggedError("SnapshotBuildError")<{
  message: string;
  exitCode: number;
}> {}

class SnapshotInputsChangedError extends TaggedError(
  "SnapshotInputsChangedError",
)<{ message: string }> {}

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
    if (candidate === undefined || !path.isAbsolute(candidate)) {
      continue;
    }
    const canonicalFile = realpathSync(candidate);
    if (
      canonicalFile.split(path.sep).includes("node_modules") ||
      !canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)
    ) {
      // The installed location distinguishes dependency versions even when
      // bun.lock has changed without a matching install in this checkout.
      visited.add(candidate);
      visited.add(canonicalFile);
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
  const packageManifest = path.join(repositoryRoot, "package.json");
  if (statSync(packageManifest, { throwIfNoEntry: false })?.isFile()) {
    visited.add(packageManifest);
  }
  const patchRoot = path.join(repositoryRoot, "patches");
  if (statSync(patchRoot, { throwIfNoEntry: false })?.isDirectory()) {
    const directories = [patchRoot];
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
  const hash = createSha256();
  const canonicalRoot = realpathSync(repositoryRoot);
  hash.update(SNAPSHOT_FORMAT);
  hash.update("\0");
  hash.update(Bun.version);
  const inputs = snapshotInputPaths(repositoryRoot, entryPoint)
    .map((filePath) => {
      let identity = filePath;
      if (filePath.startsWith(`${repositoryRoot}${path.sep}`)) {
        identity = path.relative(repositoryRoot, filePath);
      } else if (filePath.startsWith(`${canonicalRoot}${path.sep}`)) {
        identity = path.relative(canonicalRoot, filePath);
      }
      return { filePath, identity };
    })
    .toSorted((a, b) => compareCodeUnit(a.identity, b.identity));
  for (const { filePath, identity } of inputs) {
    hash.update("\0");
    hash.update(identity);
    hash.update("\0");
    hash.update(readFileSync(filePath));
  }
  return hash.digest("hex");
};

export const snapshotCacheDir = (env: NodeJS.ProcessEnv) =>
  env["STELLA_PGLITE_SNAPSHOT_CACHE_DIR"] ??
  path.join(
    env["XDG_CACHE_HOME"] ?? path.join(homedir(), ".cache"),
    "stella/pglite",
  );

export const snapshotDigest = async (filePath: string) => {
  const hash = createSha256();
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
  signal?: AbortSignal;
  timeoutMs?: number;
};

const assertNotAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) {
    throw new SnapshotBuildError({
      message: "PGlite snapshot cache wait interrupted.",
      exitCode: 1,
    });
  }
};

const waitForLock = async (signal: AbortSignal | undefined) => {
  assertNotAborted(signal);
  try {
    await sleep(POLL_MS, undefined, { signal });
  } catch (error) {
    assertNotAborted(signal);
    throw error;
  }
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
    for (const name of readdirSync(cacheDir)) {
      const match = /^([a-f0-9]{64})\.(?:tar|sha256)\.tmp-/u.exec(name);
      if (!match) {
        continue;
      }
      const filePath = path.join(cacheDir, name);
      if (
        Date.now() - statSync(filePath).mtimeMs >= MAX_TEMP_AGE_MS &&
        (match[1] === currentKey ||
          !statSync(path.join(cacheDir, `${String(match[1])}.lock`), {
            throwIfNoEntry: false,
          }))
      ) {
        rmSync(filePath, { force: true });
      }
    }
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
  signal,
  timeoutMs = LOCK_TIMEOUT_MS,
}: AcquireOptions): Promise<CacheResult> => {
  assertNotAborted(signal);
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
    assertNotAborted(signal);
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
            try {
              if (
                Date.now() - statSync(takeoverDir).mtimeMs >=
                STALE_TAKEOVER_MS
              ) {
                rmSync(takeoverDir, { recursive: true, force: true });
              }
            } catch {
              // Another waiter may already have removed it.
            }
            await waitForLock(signal);
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
      } catch (staleError) {
        if (staleError instanceof SnapshotBuildError) {
          throw staleError;
        }
        // Another process may have released or replaced the lock.
      }
      await waitForLock(signal);
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
        assertNotAborted(signal);
        if (!valid) {
          rmSync(finalPath);
          rmSync(path.join(cacheDir, `${key}.sha256`), { force: true });
        } else {
          return {
            status: "hit",
            snapshot: leaseSnapshot(cacheDir, key, finalPath),
          };
        }
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
      let valid: boolean;
      try {
        valid = await validate(finalPath);
      } catch (error) {
        assertNotAborted(signal);
        throw error;
      }
      assertNotAborted(signal);
      if (!valid) {
        return {
          status: "fallback",
          reason: "built snapshot is unreadable or corrupt",
        };
      }
      const snapshot = leaseSnapshot(cacheDir, key, finalPath);
      prune(cacheDir, key);
      return { status: "hit", snapshot };
    } catch (error) {
      if (
        error instanceof SnapshotBuildError ||
        error instanceof SnapshotInputsChangedError
      ) {
        throw error;
      }
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

type CurrentSnapshotOptions = Omit<AcquireOptions, "key" | "build"> & {
  key: () => string;
  build: (filePath: string) => Promise<void>;
};

export const acquireCurrentSnapshot = async ({
  key,
  build,
  ...options
}: CurrentSnapshotOptions): Promise<CacheResult> => {
  for (let attempt = 0; attempt < MAX_INPUT_RETRIES; attempt += 1) {
    const expectedKey = key();
    let result: CacheResult;
    try {
      result = await acquireCachedSnapshot({
        ...options,
        key: expectedKey,
        build: async (filePath) => {
          await build(filePath);
          if (key() !== expectedKey) {
            throw new SnapshotInputsChangedError({
              message: "Snapshot inputs changed during the build.",
            });
          }
        },
      });
    } catch (error) {
      if (error instanceof SnapshotInputsChangedError) {
        continue;
      }
      throw error;
    }
    if (result.status === "fallback") {
      return result;
    }
    if (key() === expectedKey) {
      return result;
    }
    result.snapshot.release();
  }
  return {
    status: "fallback",
    reason: "snapshot inputs kept changing during cache acquisition",
  };
};
