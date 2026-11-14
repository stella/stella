import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { createSha256 } from "../packages/sha256/src/bun";

const MARKER = ".stella-install-complete";
const STORE_CACHE_VERSION = "v4";

const repoRelativePath = (from: string, to: string) =>
  path.posix.relative(from.replaceAll("\\", "/"), to.replaceAll("\\", "/"));

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizedLock = (source: string) => {
  const lock: unknown = Bun.JSONC.parse(source);
  if (!isRecord(lock) || !isRecord(lock["workspaces"])) {
    throw new InstallStoreInvariantError("Invalid bun.lock workspaces");
  }
  for (const workspace of Object.values(lock["workspaces"])) {
    if (!isRecord(workspace)) {
      throw new InstallStoreInvariantError("Invalid bun.lock workspace");
    }
    // Workspace self versions do not change dependency resolution or extraction.
    // Retain every other lock field, including dependency versions and integrity.
    delete workspace["version"];
  }
  return JSON.stringify(lock);
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
        lock: createSha256()
          .update(normalizedLock(readFileSync(lockfile, "utf-8")))
          .digest("hex"),
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

export const installStoreRestorePrefix = (key: string) => {
  const separator = key.lastIndexOf("-");
  if (separator === -1) {
    throw new InstallStoreInvariantError("Invalid install-store key");
  }
  return key.slice(0, separator + 1);
};

type LockStoreEntries = {
  identities: Set<string>;
  unmappablePackageNames: Set<string>;
};

const lockStoreEntries = (root: string): LockStoreEntries => {
  const lock: unknown = Bun.JSONC.parse(
    readFileSync(path.join(root, "bun.lock"), "utf-8"),
  );
  if (!isRecord(lock) || !isRecord(lock["packages"])) {
    throw new InstallStoreInvariantError("Invalid bun.lock packages");
  }
  const identities = new Set<string>();
  const unmappablePackageNames = new Set<string>();
  for (const value of Object.values(lock["packages"])) {
    if (!Array.isArray(value) || typeof value[0] !== "string") {
      continue;
    }
    const resolution = value[0];
    const source =
      /@(?<kind>github:|git\+|https?:\/\/|file:|link:|workspace:|root:|\.{0,2}\/)/u.exec(
        resolution,
      );
    if (source?.groups?.["kind"] === undefined) {
      identities.add(resolution);
      continue;
    }
    const packageName = resolution.slice(0, source.index);
    const kind = source.groups["kind"];
    const tag = value.at(2);
    if (kind === "github:" && typeof tag === "string") {
      identities.add(`@GH@${tag}`);
    } else if (kind === "git+" && typeof tag === "string") {
      identities.add(`@G@${tag}`);
    } else if (
      (kind === "http://" ||
        kind === "https://" ||
        kind === "./" ||
        kind === "../" ||
        kind === "/") &&
      typeof tag === "string" &&
      tag.startsWith("sha512-")
    ) {
      const hash = Buffer.from(tag.slice("sha512-".length), "base64")
        .toString("hex")
        .slice(0, 32);
      identities.add(`@T@sha512-${hash}`);
    } else {
      unmappablePackageNames.add(packageName);
    }
  }
  return { identities, unmappablePackageNames };
};

const lockNeedsStoreEntry = (
  entries: LockStoreEntries,
  identity: string,
  packageName: string,
) =>
  entries.identities.has(identity.replace(/@@@\d+$/u, "")) ||
  entries.unmappablePackageNames.has(packageName);

// A prefix restore may contain packages from the previous lock. Remove every
// identifiable package absent from the current lock before sealing the new key.
export const pruneInstallStore = (store: string, root: string) => {
  const needed = lockStoreEntries(root);
  const pending = [store];
  for (const directory of pending) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (!entry.isDirectory() || entry.name === "links") {
        continue;
      }
      const manifest = path.join(filename, "package.json");
      if (!existsSync(manifest)) {
        pending.push(filename);
        continue;
      }
      const metadata: unknown = Bun.JSONC.parse(
        readFileSync(manifest, "utf-8"),
      );
      if (
        isRecord(metadata) &&
        typeof metadata["name"] === "string" &&
        typeof metadata["version"] === "string" &&
        !lockNeedsStoreEntry(
          needed,
          repoRelativePath(store, filename),
          metadata["name"],
        )
      ) {
        rmSync(filename, { recursive: true, force: true });
      }
    }
  }
};

const assertInstallStoreExact = (store: string, root: string) => {
  const extraCandidates: { identity: string; packageName: string }[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (!entry.isDirectory() || entry.name === "links") {
        continue;
      }
      const manifest = path.join(filename, "package.json");
      if (!existsSync(manifest)) {
        visit(filename);
        continue;
      }
      const metadata: unknown = Bun.JSONC.parse(
        readFileSync(manifest, "utf-8"),
      );
      if (
        isRecord(metadata) &&
        typeof metadata["name"] === "string" &&
        typeof metadata["version"] === "string"
      ) {
        extraCandidates.push({
          identity: repoRelativePath(store, filename),
          packageName: metadata["name"],
        });
      }
    }
  };
  visit(store);
  const needed = lockStoreEntries(root);
  const extra = extraCandidates.find(
    ({ identity, packageName }) =>
      !lockNeedsStoreEntry(needed, identity, packageName),
  );
  if (extra !== undefined) {
    throw new InstallStoreInvariantError(
      `Install store contains package outside current lock: ${extra.identity}`,
    );
  }
};

type ExtractionScratchOptions = {
  directory: string;
  entry: string;
  filename: string;
};

const isExtractionScratch = ({
  directory,
  entry,
  filename,
}: ExtractionScratchOptions) => {
  if (
    (directory !== "" && directory !== "links") ||
    !/\.tmp(?:-|$)/u.test(entry)
  ) {
    return false;
  }
  const manifest = path.join(filename, "package.json");
  if (
    directory !== "" ||
    !lstatSync(filename).isDirectory() ||
    !existsSync(manifest)
  ) {
    return true;
  }
  // A root package name may end in .tmp; extraction scratch does not
  // carry a manifest identifying that directory as the package itself.
  const metadata: unknown = Bun.JSONC.parse(readFileSync(manifest, "utf-8"));
  return !isRecord(metadata) || metadata["name"] !== entry;
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
      const relative = path.join(directory, entry);
      const filename = path.join(store, relative);
      const stat = lstatSync(filename);
      // Bun leaves its empty extraction scratch directory on Windows.
      if (
        directory === "" &&
        entry === ".tmp" &&
        stat.isDirectory() &&
        readdirSync(filename).length === 0
      ) {
        continue;
      }
      if (isExtractionScratch({ directory, entry, filename })) {
        throw new InstallStoreInvariantError(
          `Incomplete Bun install store: ${relative}`,
        );
      }
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
  root?: string;
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
  assertInstallStoreExact(options.store, options.root ?? process.cwd());
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

// Hosted Linux runners keep RUNNER_TEMP here; job containers mount the same
// directory at /__w. Cache versions hash the absolute store path and Bun
// global-store links are absolute, so both environments use this one path.
const HOSTED_LINUX_WORK = "/home/runner/work";
const CONTAINER_WORK = "/__w";

// Astro resolves a module id as project-relative unless it shares a
// non-root ancestor with the project, so a store under /tmp breaks Astro
// builds that load .astro files from the store.
const sharesNonRootAncestor = (left: string, right: string) => {
  const first = path.resolve(left).split(path.sep).find(Boolean);
  return (
    first !== undefined &&
    first === path.resolve(right).split(path.sep).find(Boolean)
  );
};

export const installStorePath = ({
  key,
  platform,
  runnerTemp,
  workspace,
}: {
  key: string;
  platform: string;
  runnerTemp: string;
  workspace: string;
}) => {
  const container =
    platform === "linux" &&
    runnerTemp === path.join(CONTAINER_WORK, "_temp") &&
    workspace.startsWith(`${CONTAINER_WORK}/`);
  const canonicalTemp =
    platform === "linux" &&
    (container || runnerTemp === path.join(HOSTED_LINUX_WORK, "_temp"))
      ? path.join(HOSTED_LINUX_WORK, "_temp")
      : runnerTemp;
  const store = path.join(canonicalTemp, "bun-scoped-install", key);
  const resolved = container
    ? `${CONTAINER_WORK}${store.slice(HOSTED_LINUX_WORK.length)}`
    : store;
  if (!sharesNonRootAncestor(resolved, workspace)) {
    throw new InstallStoreInvariantError(
      `Install store ${resolved} shares no non-root ancestor with workspace ${workspace}`,
    );
  }
  return {
    store,
    alias: container
      ? { link: HOSTED_LINUX_WORK, target: CONTAINER_WORK }
      : undefined,
  };
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
    console.log(`restore-prefix=${installStoreRestorePrefix(key)}`);
    const temporary = process.env["RUNNER_TEMP"];
    if (temporary !== undefined) {
      const { store: storePath, alias } = installStorePath({
        key,
        platform: process.platform,
        runnerTemp: temporary,
        workspace: process.env["GITHUB_WORKSPACE"] ?? process.cwd(),
      });
      console.log(`store=${storePath}`);
      if (alias !== undefined) {
        console.log(`alias-link=${alias.link}`);
        console.log(`alias-target=${alias.target}`);
      }
    }
  } else if (
    (operation === "seal" || operation === "verify" || operation === "prune") &&
    args.length === 1 &&
    args[0]
  ) {
    const options = { store, key: args[0], globalStoreMode };
    if (operation === "prune") {
      pruneInstallStore(store, process.cwd());
    } else if (operation === "seal") {
      sealInstallStore(options);
    } else {
      verifyInstallStore(options);
    }
  } else {
    throw new InstallStoreInvariantError(
      "Usage: ci-install-store.ts key | prune <key> | seal <key> | verify <key>",
    );
  }
}
