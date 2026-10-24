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
import type { Fingerprint, HashSource } from "@expo/fingerprint";
import { panic } from "better-result";
import path from "node:path";

import { APP_VERSION } from "../app.config";

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
  const [, major, minor] = match;
  return major === "0" ? `0.${minor}` : `${major}`;
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
    sourceSkips: FINGERPRINT_SOURCE_SKIPS,
    extraSources: [
      {
        type: "contents",
        id: "releaseLine",
        contents: releaseLine(APP_VERSION),
        reasons: ["releaseLine"],
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

export const nativeFingerprint = async (
  platform: NativePlatform,
  projectRoot: string = APP_ROOT,
): Promise<string> =>
  (await createNativeFingerprint(platform, projectRoot)).hash;

/** A source by the name the check reports: its file, or its id. */
export type FingerprintSourceHash = {
  readonly source: string;
  readonly type: HashSource["type"];
  readonly hash: string | null;
};

export const sourceHashes = (
  fingerprint: Pick<Fingerprint, "sources">,
): FingerprintSourceHash[] =>
  fingerprint.sources.map((source) => ({
    source: source.type === "contents" ? source.id : source.filePath,
    type: source.type,
    hash: source.hash,
  }));

if (import.meta.main) {
  const [platform = "", format] = process.argv.slice(2);
  if (!isNativePlatform(platform) || ![undefined, "--json"].includes(format)) {
    process.stderr.write(
      "usage: bun scripts/fingerprint.ts <ios|android> [--json]\n",
    );
    process.exit(1);
  }
  const fingerprint = await createNativeFingerprint(platform, APP_ROOT);
  process.stdout.write(
    format === "--json"
      ? `${JSON.stringify({ hash: fingerprint.hash, sources: sourceHashes(fingerprint) })}\n`
      : `${fingerprint.hash}\n`,
  );
}
