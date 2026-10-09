import {
  Result,
  TaggedError,
  panic,
  type TaggedErrorClass,
} from "better-result";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { DEV_MODES, type DevMode } from "./dev-runner-config";

// Machine-readable state of a running dev runner. Scripts and agents read the
// live URLs from here instead of scraping the console summary, which moves
// whenever the runner shifts to free ports. Lives under the checkout root and
// is gitignored.
export const DEV_STATE_DIR = ".stella-dev";
const RUNTIME_FILE = "runtime.json";
const CONTENT_ENCRYPTION_KEY_FILE = "content-encryption-key";
// Written after the seed by apps/api/scripts/seed-seal.ts.
export const SEAL_FILE = "seal.json";

export type DevRuntime = {
  apiUrl: string | null;
  dockerProject: string | null;
  infraOffset: number;
  mode: DevMode;
  /** Process whose exit ends the stack; null when only `down` ends it. */
  ownerPid: number | null;
  pid: number;
  seeded: boolean;
  startedAt: string;
  webUrl: string | null;
};

export const DEV_OWNER_PID_ENV = "STELLA_DEV_OWNER_PID";

export type StackShutdownReason = "owner-exited" | "checkout-removed";

type StackShutdownReasonOptions = {
  checkoutExists: boolean;
  ownerAlive: boolean | null;
};

// A stack must not outlive what it serves: the process that asked for it
// (`ownerAlive` is null when none was named) or the checkout holding its state.
export const stackShutdownReason = ({
  checkoutExists,
  ownerAlive,
}: StackShutdownReasonOptions): StackShutdownReason | null => {
  if (!checkoutExists) {
    return "checkout-removed";
  }
  return ownerAlive === false ? "owner-exited" : null;
};

// EPERM means the process exists but belongs to someone else.
export const isPidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export const parseOwnerPid = (value: string | undefined) => {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
};

export const devStatePath = (rootDir: string, fileName: string) =>
  path.join(rootDir, DEV_STATE_DIR, fileName);

const runtimePath = (rootDir: string) => devStatePath(rootDir, RUNTIME_FILE);

const DevContentEncryptionKeyErrorBase: TaggedErrorClass<"DevContentEncryptionKeyError"> =
  TaggedError("DevContentEncryptionKeyError");

class DevContentEncryptionKeyError extends DevContentEncryptionKeyErrorBase<{
  cause: unknown;
  message: string;
}> {}

export const readOrCreateDevContentEncryptionKey = (
  rootDir: string,
): Result<string, DevContentEncryptionKeyError> => {
  const filePath = devStatePath(rootDir, CONTENT_ENCRYPTION_KEY_FILE);
  const filesystemError = (cause: unknown) =>
    new DevContentEncryptionKeyError({
      cause,
      message: `Could not initialize local content encryption key at ${filePath}`,
    });
  if (!existsSync(filePath)) {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const written = Result.try({
      try: () => {
        mkdirSync(path.join(rootDir, DEV_STATE_DIR), { recursive: true });
        writeFileSync(temporaryPath, randomBytes(32).toString("hex"), {
          flag: "wx",
          mode: 0o600,
        });
      },
      catch: filesystemError,
    });
    // Publish only complete contents, without replacing another runner's key.
    const published = written.isErr()
      ? written
      : Result.try({
          try: () => linkSync(temporaryPath, filePath),
          catch: filesystemError,
        });
    const cleaned = Result.try({
      try: () => rmSync(temporaryPath, { force: true }),
      catch: filesystemError,
    });
    if (written.isErr()) {
      return written;
    }
    if (published.isErr()) {
      const cause = published.error.cause;
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "EEXIST")
      ) {
        return published;
      }
    }
    if (cleaned.isErr()) {
      return cleaned;
    }
  }
  const read = Result.try({
    try: () => readFileSync(filePath, "utf-8").trim(),
    catch: filesystemError,
  });
  if (read.isErr()) {
    return read;
  }
  if (!/^[a-f0-9]{64}$/u.test(read.value)) {
    return Result.err(
      new DevContentEncryptionKeyError({
        cause: undefined,
        message: `${filePath} must contain a 32-byte hexadecimal key`,
      }),
    );
  }
  return Result.ok(read.value);
};

export const writeDevRuntime = (rootDir: string, runtime: DevRuntime) => {
  mkdirSync(path.join(rootDir, DEV_STATE_DIR), { recursive: true });
  // Written beside and renamed into place, so a reader polling the file never
  // sees it truncated or half written.
  const temporaryPath = `${runtimePath(rootDir)}.${String(process.pid)}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(runtime, null, 2)}\n`);
  renameSync(temporaryPath, runtimePath(rootDir));
};

// Only the runner that wrote the file removes it, so a runner that failed to
// start never deletes the state of the one still serving this checkout.
export const removeDevRuntime = (rootDir: string, pid: number) => {
  if (readDevRuntime(rootDir)?.pid === pid) {
    rmSync(runtimePath(rootDir), { force: true });
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown) =>
  value === null || typeof value === "string";

const isDevMode = (value: unknown): value is DevMode =>
  DEV_MODES.some((mode) => mode === value);

const parseDevRuntime = (value: unknown): DevRuntime | null => {
  if (
    !isRecord(value) ||
    !isNullableString(value["apiUrl"]) ||
    !isNullableString(value["dockerProject"]) ||
    typeof value["infraOffset"] !== "number" ||
    !isDevMode(value["mode"]) ||
    !(value["ownerPid"] === null || typeof value["ownerPid"] === "number") ||
    typeof value["pid"] !== "number" ||
    typeof value["seeded"] !== "boolean" ||
    typeof value["startedAt"] !== "string" ||
    !isNullableString(value["webUrl"])
  ) {
    return null;
  }
  return {
    apiUrl: value["apiUrl"],
    dockerProject: value["dockerProject"],
    infraOffset: value["infraOffset"],
    mode: value["mode"],
    ownerPid: value["ownerPid"],
    pid: value["pid"],
    seeded: value["seeded"],
    startedAt: value["startedAt"],
    webUrl: value["webUrl"],
  };
};

export const readDevRuntime = (rootDir: string): DevRuntime | null => {
  const filePath = runtimePath(rootDir);
  if (!existsSync(filePath)) {
    return null;
  }
  const runtime = parseDevRuntime(JSON.parse(readFileSync(filePath, "utf-8")));
  if (runtime === null) {
    // The runner in this package is the only writer; a shape it does not
    // produce means a stale file from an incompatible version.
    panic(`${filePath} has an unexpected shape; delete it and restart`);
  }
  return runtime;
};
