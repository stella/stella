import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { createSha256 } from "../packages/sha256/src/bun";

const MARKER = ".stella-install-complete";
const STORE_CACHE_VERSION = "v3";

export type GlobalStoreMode = "enabled" | "disabled";

class InstallStoreInvariantError extends Error {
  override name = "InstallStoreInvariantError";
  readonly _tag = "InstallStoreInvariantError";
}

type InstallStoreIdentityOptions = {
  root: string;
  flags: readonly string[];
  platform?: string;
  arch?: string;
  revision?: string;
  globalStoreMode?: GlobalStoreMode;
};

const assertIdentity = (name: string, value: string) => {
  if (value.trim() === "") {
    throw new InstallStoreInvariantError(`Missing install-store ${name}`);
  }
};

export const parseGlobalStoreMode = (
  value: string | undefined,
): GlobalStoreMode => {
  if (value === undefined || value === "1" || value === "true") {
    return "enabled";
  }
  if (value === "0" || value === "false") {
    return "disabled";
  }
  throw new InstallStoreInvariantError(
    "BUN_INSTALL_GLOBAL_STORE must be 0, 1, false or true",
  );
};

export const completeInstallStoreKey = ({
  root,
  flags,
  platform = process.platform,
  arch = process.arch,
  revision = Bun.revision,
  globalStoreMode = "enabled",
}: InstallStoreIdentityOptions) => {
  assertIdentity("repository root", root);
  for (const [name, value] of [
    ["platform", platform],
    ["architecture", arch],
    ["Bun revision", revision],
  ] as const) {
    assertIdentity(name, value);
  }
  if (globalStoreMode !== "enabled" && globalStoreMode !== "disabled") {
    throw new InstallStoreInvariantError(
      "Invalid global Bun install-store mode",
    );
  }
  if (flags.length === 0 || flags.some((flag) => flag.trim() === "")) {
    throw new InstallStoreInvariantError(
      "Install-store cache requires non-empty ordered flags",
    );
  }
  if (
    !flags.includes("--frozen-lockfile") ||
    !flags.includes("--ignore-scripts")
  ) {
    throw new InstallStoreInvariantError(
      "Install-store cache requires --frozen-lockfile and --ignore-scripts",
    );
  }

  const lockfile = path.join(root, "bun.lock");
  const configuration = path.join(root, "bunfig.toml");
  if (!existsSync(lockfile)) {
    throw new InstallStoreInvariantError(
      "Missing bun.lock for install-store key",
    );
  }
  if (!existsSync(configuration)) {
    throw new InstallStoreInvariantError(
      "Missing required bunfig.toml for install-store key",
    );
  }

  const digest = createSha256()
    .update(
      JSON.stringify({
        format: STORE_CACHE_VERSION,
        lock: createSha256().update(readFileSync(lockfile)).digest("hex"),
        configuration: createSha256()
          .update(readFileSync(configuration))
          .digest("hex"),
        platform,
        arch,
        revision,
        flags,
        globalStoreMode,
      }),
    )
    .digest("hex");
  return `bun-complete-store-${STORE_CACHE_VERSION}-${platform}-${arch}-${revision}-${globalStoreMode}-${digest}`;
};

const storeFingerprint = (store: string, globalStoreMode: GlobalStoreMode) => {
  const root = lstatSync(store);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new InstallStoreInvariantError(
      "Bun install store must be a directory",
    );
  }

  const digest = createSha256();
  const pending = [""];
  let payloadCount = 0;
  let hasLinks = false;
  for (const directory of pending) {
    const entries = readdirSync(path.join(store, directory)).toSorted();
    for (const entry of entries) {
      if (directory === "" && entry === MARKER) {
        continue;
      }
      if (
        (directory === "" || directory === "links") &&
        /\.tmp(?:-|$)/u.test(entry)
      ) {
        throw new InstallStoreInvariantError(
          `Incomplete Bun install store: ${path.join(directory, entry)}`,
        );
      }
      const relative = path.join(directory, entry);
      const filename = path.join(store, relative);
      const stat = lstatSync(filename);
      let kind = "file";
      if (stat.isDirectory()) {
        kind = "directory";
      } else if (stat.isSymbolicLink()) {
        kind = "symlink";
      }
      if (directory === "" && entry === "links" && stat.isDirectory()) {
        hasLinks = true;
      }
      if (!(directory === "" && entry === "links") && !stat.isDirectory()) {
        payloadCount += 1;
      }
      digest.update(
        JSON.stringify([
          relative,
          kind,
          stat.isDirectory() ? 0 : stat.size,
          stat.isSymbolicLink() ? readlinkSync(filename) : "",
        ]),
      );
      if (stat.isDirectory()) {
        pending.push(relative);
      }
    }
  }
  if (payloadCount === 0) {
    throw new InstallStoreInvariantError("Empty Bun install store");
  }
  if (globalStoreMode === "enabled" && !hasLinks) {
    throw new InstallStoreInvariantError(
      "Global Bun install store is missing its links directory",
    );
  }
  if (hasLinks && readdirSync(path.join(store, "links")).length === 0) {
    throw new InstallStoreInvariantError(
      "Empty Bun install-store links directory",
    );
  }
  return digest.digest("hex");
};

type InstallStoreOptions = {
  store: string;
  key: string;
  globalStoreMode: GlobalStoreMode;
};

const markerContents = ({
  store,
  key,
  globalStoreMode,
}: InstallStoreOptions) => {
  assertIdentity("key", key);
  const fingerprint = storeFingerprint(store, globalStoreMode);
  return `${JSON.stringify({
    format: STORE_CACHE_VERSION,
    key,
    globalStoreMode,
    fingerprint,
  })}\n`;
};

export const sealInstallStore = (options: InstallStoreOptions) => {
  writeFileSync(path.join(options.store, MARKER), markerContents(options));
};

export const verifyInstallStore = (options: InstallStoreOptions) => {
  const marker = path.join(options.store, MARKER);
  if (
    !existsSync(marker) ||
    readFileSync(marker, "utf-8") !== markerContents(options)
  ) {
    throw new InstallStoreInvariantError(
      "Incomplete or mismatched Bun install-store cache",
    );
  }
};

export const parseInstallFlags = (serialized: string | undefined) => {
  if (serialized === undefined) {
    throw new InstallStoreInvariantError(
      "STELLA_CI_INSTALL_FLAGS must be a JSON array",
    );
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new InstallStoreInvariantError(
      "STELLA_CI_INSTALL_FLAGS must be a JSON array of strings",
    );
  }
  const flags: string[] = [];
  for (const flag of parsed) {
    if (typeof flag !== "string") {
      throw new InstallStoreInvariantError(
        "STELLA_CI_INSTALL_FLAGS must be a JSON array of strings",
      );
    }
    flags.push(flag);
  }
  return flags;
};

if (import.meta.main) {
  const [operation, ...args] = process.argv.slice(2);
  const store =
    process.env["BUN_INSTALL_CACHE_DIR"] ??
    path.join(homedir(), ".bun/install/cache");
  const globalStoreMode = parseGlobalStoreMode(
    process.env["BUN_INSTALL_GLOBAL_STORE"],
  );
  if (operation === "key" && args.length === 0) {
    const key = completeInstallStoreKey({
      root: process.cwd(),
      flags: parseInstallFlags(process.env["STELLA_CI_INSTALL_FLAGS"]),
      globalStoreMode,
    });
    console.log(`key=${key}`);
    const temporary = process.env["RUNNER_TEMP"];
    if (temporary !== undefined) {
      console.log(`store=${path.join(temporary, "bun-scoped-install", key)}`);
    }
  } else if (
    (operation === "seal" || operation === "verify") &&
    args.length === 1 &&
    args[0]
  ) {
    const options = { store, key: args[0], globalStoreMode };
    if (operation === "seal") {
      sealInstallStore(options);
    } else {
      verifyInstallStore(options);
    }
  } else {
    throw new InstallStoreInvariantError(
      "Usage: ci-install-store.ts key | seal <key> | verify <key>",
    );
  }
}
