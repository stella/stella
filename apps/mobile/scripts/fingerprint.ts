// The one definition of the app's native fingerprint: a hash of everything
// compiled into the native shell (native modules, their versions, the app
// config, patches), and nothing that ships in the JavaScript bundle.
//
// Every consumer reads it from here with the same options: the development
// client check, the pull request check, the TestFlight build (which stamps it
// as the runtime version) and update publishing (which targets it). Two
// computations that disagreed would publish an update no installed build
// accepts, or one a build cannot run.
//
// Usage: bun scripts/fingerprint.ts <ios|android> [--json]   (honours APP_VARIANT)
// `--json` prints the hash with every source's own hash, so the pull request
// check can name what moved it.

import { createFingerprintAsync, SourceSkips } from "@expo/fingerprint";
import type {
  Fingerprint,
  FingerprintSource,
  HashSource,
} from "@expo/fingerprint";
import { panic } from "better-result";
import path from "node:path";

import { sha256Hex } from "@stll/sha256/bun";

import { APP_VERSION, BAR_GLYPHS_FOLDER } from "../app.config";

export const NATIVE_PLATFORMS = ["ios", "android"] as const;

export type NativePlatform = (typeof NATIVE_PLATFORMS)[number];

const APP_ROOT = path.resolve(import.meta.dir, "..");

/**
 * The build number changes on every TestFlight run and the runtime version is
 * this fingerprint itself, so neither may feed it; everything else in the app
 * config does, the variant's name, identifier and scheme included.
 */
// The flags are distinct bits, so their sum is the combined mask.
export const FINGERPRINT_SOURCE_SKIPS: number =
  SourceSkips.ExpoConfigVersions + SourceSkips.ExpoConfigRuntimeVersionIfString;

/**
 * The part of the store version an update may not cross: the major version,
 * or major and minor while the app is below 1.0. Skipping the version above
 * would let an update for a new release reach every older build whose native
 * code happens to match; hashing the release line keeps each line's updates
 * on its own builds.
 */
export const releaseLine = (version: string): string => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) {
    return panic(`app version ${version} is not major.minor.patch`);
  }
  const [, major = "", minor = ""] = match;
  return major === "0" ? `0.${minor}` : major;
};

/**
 * `@expo/fingerprint` returns no sources, rather than failing, when Expo
 * autolinking errors; the hash then stops moving with native changes and
 * updates reach builds that lack them. A fingerprint must hash at least one
 * autolinked module.
 */
const AUTOLINKING_REASON = {
  ios: "expoAutolinkingIos",
  android: "expoAutolinkingAndroid",
} as const satisfies Record<NativePlatform, string>;

export const hashesExpoModules = (
  platform: NativePlatform,
  sources: readonly Pick<HashSource, "reasons">[],
): boolean =>
  sources.some((source) =>
    source.reasons.includes(AUTOLINKING_REASON[platform]),
  );

export const isNativePlatform = (value: string): value is NativePlatform =>
  NATIVE_PLATFORMS.some((platform) => platform === value);

const createNativeFingerprint = async (
  platform: NativePlatform,
  projectRoot: string,
): Promise<Fingerprint> => {
  const fingerprint = await createFingerprintAsync(projectRoot, {
    platforms: [platform],
    silent: true,
    // Each directory's file tree, so its hash can be taken again under
    // portable paths (portableFingerprint).
    debug: true,
    sourceSkips: FINGERPRINT_SOURCE_SKIPS,
    extraSources: [
      {
        type: "contents",
        id: "releaseLine",
        contents: releaseLine(APP_VERSION),
        reasons: ["releaseLine"],
      },
      // Copied into the asset catalog at prebuild, out of the config's sight.
      {
        type: "dir",
        filePath: BAR_GLYPHS_FOLDER,
        reasons: ["barGlyphs"],
      },
    ],
  });
  if (!hashesExpoModules(platform, fingerprint.sources)) {
    return panic(
      `the ${platform} fingerprint hashes no Expo native modules; autolinking failed`,
    );
  }
  return fingerprint;
};

/** A source by the name the check reports: its file, or its id. */
export type FingerprintSourceHash = {
  readonly source: string;
  readonly type: HashSource["type"];
  readonly hash: string | null;
};

export type NativeFingerprint = {
  readonly hash: string;
  readonly sources: readonly FingerprintSourceHash[];
};

/**
 * Bun links every package through a store whose place depends on the machine
 * and the install: `node_modules/.bun/…` in a full install,
 * `~/.bun/install/cache/links/…` in CI's filtered one. `@expo/fingerprint`
 * keeps those paths in its source names and in the autolinking config it
 * hashes, so one commit would fingerprint differently on every machine, and
 * an update published on one would never reach a build made on another.
 * Each path is cut to its last `node_modules/`; the files' contents and the
 * packages' versions still decide the hash.
 */
const NODE_MODULES = "/node_modules/";

/** Where a path ends inside a source: whitespace or a quote. */
const isPathBreak = (char: string): boolean =>
  char.trim() === "" || char === '"' || char === "'" || char === "`";

const cutToPackage = (storePath: string): string => {
  const at = storePath.lastIndexOf(NODE_MODULES);
  return at === -1
    ? storePath
    : `node_modules/${storePath.slice(at + NODE_MODULES.length)}`;
};

export const portablePath = (text: string): string => {
  let portable = "";
  let pathStart = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    if (char === undefined || isPathBreak(char)) {
      portable += cutToPackage(text.slice(pathStart, index)) + (char ?? "");
      pathStart = index + 1;
    }
  }
  return portable;
};

const byCodeUnit = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const sortKey = ({ source, hash }: FingerprintSourceHash): string =>
  `${source}\0${hash ?? ""}`;

/** A file's content hash, or a directory's tree of them, as `debug` reports it. */
type HashedTree = {
  readonly path: string;
  readonly hash: string;
  readonly children?: readonly (HashedTree | undefined)[];
};

const isHashedTree = (value: unknown): value is HashedTree =>
  typeof value === "object" &&
  value !== null &&
  "path" in value &&
  typeof value.path === "string" &&
  "hash" in value &&
  typeof value.hash === "string";

/**
 * A directory's hash names each file by its path, which runs through the
 * package store; it is taken again over portable paths and the files'
 * contents, in a fixed order.
 */
const treeHash = (tree: HashedTree): string =>
  tree.children === undefined
    ? tree.hash
    : sha256Hex(
        tree.children
          .filter((child): child is HashedTree => child !== undefined)
          .map((child) => `${portablePath(child.path)}\0${treeHash(child)}`)
          .toSorted(byCodeUnit)
          .join("\n"),
      );

/**
 * The modules Node loads while evaluating the app config are hashed as config
 * plugins, but which helpers load depends on the Node version: Linux CI's
 * strips TypeScript through a package macOS's does not need. The plugins
 * this app uses ship in Expo's own native modules, whose versions the
 * autolinking config hashes, so only the project's own files count here.
 */
const isPackageLoadedByConfig = (
  source: Pick<FingerprintSource, "reasons">,
  name: string,
): boolean =>
  source.reasons.includes("expoConfigPlugins") &&
  name.startsWith("node_modules/");

const portableSource = (
  source: FingerprintSource,
): FingerprintSourceHash | undefined => {
  if (source.type === "contents") {
    return {
      source: source.id,
      type: source.type,
      hash:
        source.hash === null
          ? null
          : sha256Hex(portablePath(source.contents.toString())),
    };
  }
  const name = portablePath(source.filePath);
  if (isPackageLoadedByConfig(source, name)) {
    return undefined;
  }
  return {
    source: name,
    type: source.type,
    hash:
      source.type === "dir" && isHashedTree(source.debugInfo)
        ? treeHash(source.debugInfo)
        : source.hash,
  };
};

/**
 * The fingerprint under portable source names, in a fixed order, hashed to
 * the 40 hex characters a runtime version carries.
 */
export const portableFingerprint = (
  fingerprint: Pick<Fingerprint, "sources">,
): NativeFingerprint => {
  const sources = fingerprint.sources
    .flatMap((source) => portableSource(source) ?? [])
    .toSorted((left, right) => byCodeUnit(sortKey(left), sortKey(right)));
  const hashed = sources.flatMap(({ source, hash }) =>
    hash === null ? [] : [`${source}\0${hash}`],
  );
  return { hash: sha256Hex(hashed.join("\n")).slice(0, 40), sources };
};

export const nativeFingerprint = async (
  platform: NativePlatform,
  projectRoot: string = APP_ROOT,
): Promise<string> =>
  portableFingerprint(await createNativeFingerprint(platform, projectRoot))
    .hash;

if (import.meta.main) {
  const [platform = "", format] = process.argv.slice(2);
  if (!isNativePlatform(platform) || ![undefined, "--json"].includes(format)) {
    process.stderr.write(
      "usage: bun scripts/fingerprint.ts <ios|android> [--json]\n",
    );
    process.exit(1);
  }
  const fingerprint = portableFingerprint(
    await createNativeFingerprint(platform, APP_ROOT),
  );
  process.stdout.write(
    format === "--json"
      ? `${JSON.stringify(fingerprint)}\n`
      : `${fingerprint.hash}\n`,
  );
}
