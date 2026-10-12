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
const STORE_CACHE_VERSION = "v2";

class InstallStoreInvariantError extends Error {
  override name = "InstallStoreInvariantError";
  readonly _tag = "InstallStoreInvariantError";
}

export const scopedInstallStoreKey = (
  lockfile: string,
  flags: readonly string[],
) => {
  if (!flags.includes("--filter")) {
    throw new InstallStoreInvariantError(
      "Install-store cache requires scoped filters",
    );
  }
  if (!flags.includes("--frozen-lockfile")) {
    throw new InstallStoreInvariantError(
      "Install-store cache requires a frozen lockfile",
    );
  }
  const configuration = path.join(path.dirname(lockfile), "bunfig.toml");
  const digest = createSha256()
    .update(readFileSync(lockfile))
    .update(existsSync(configuration) ? readFileSync(configuration) : "")
    .update(JSON.stringify(flags))
    .digest("hex");
  return `bun-complete-store-${STORE_CACHE_VERSION}-${process.platform}-${Bun.version}-${digest}`;
};

const storeFingerprint = (store: string) => {
  const links = path.join(store, "links");
  if (!existsSync(links) || readdirSync(links).length === 0) {
    throw new InstallStoreInvariantError("Empty isolated Bun install store");
  }
  const digest = createSha256();
  const pending = [""];
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
  return digest.digest("hex");
};

type InstallStoreOptions = { store: string; key: string };

export const sealInstallStore = ({ store, key }: InstallStoreOptions) => {
  writeFileSync(
    path.join(store, MARKER),
    `${key}\n${storeFingerprint(store)}\n`,
  );
};

export const verifyInstallStore = ({ store, key }: InstallStoreOptions) => {
  const marker = path.join(store, MARKER);
  if (
    !existsSync(marker) ||
    readFileSync(marker, "utf-8") !== `${key}\n${storeFingerprint(store)}\n`
  ) {
    throw new InstallStoreInvariantError(
      "Incomplete or mismatched Bun install-store cache",
    );
  }
};

if (import.meta.main) {
  const [operation, ...args] = process.argv.slice(2);
  const store =
    process.env["BUN_INSTALL_CACHE_DIR"] ??
    path.join(homedir(), ".bun/install/cache");
  if (operation === "key") {
    console.log(`key=${scopedInstallStoreKey("bun.lock", args)}`);
  } else if (
    (operation === "seal" || operation === "verify") &&
    args.length === 1 &&
    args[0]
  ) {
    if (operation === "seal") {
      sealInstallStore({ store, key: args[0] });
    } else {
      verifyInstallStore({ store, key: args[0] });
    }
  } else {
    throw new InstallStoreInvariantError(
      "Usage: ci-install-store.ts key <install flags> | seal <key> | verify <key>",
    );
  }
}
