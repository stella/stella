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
// Usage: bun scripts/fingerprint.ts <ios|android>   (honours APP_VARIANT)

import { createFingerprintAsync, SourceSkips } from "@expo/fingerprint";
import path from "node:path";

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

export const isNativePlatform = (value: string): value is NativePlatform =>
  NATIVE_PLATFORMS.some((platform) => platform === value);

export const nativeFingerprint = async (
  platform: NativePlatform,
  projectRoot: string = APP_ROOT,
): Promise<string> =>
  (
    await createFingerprintAsync(projectRoot, {
      platforms: [platform],
      silent: true,
      sourceSkips: FINGERPRINT_SOURCE_SKIPS,
    })
  ).hash;

if (import.meta.main) {
  const platform = process.argv[2] ?? "";
  if (!isNativePlatform(platform)) {
    process.stderr.write("usage: bun scripts/fingerprint.ts <ios|android>\n");
    process.exit(1);
  }
  process.stdout.write(`${await nativeFingerprint(platform)}\n`);
}
