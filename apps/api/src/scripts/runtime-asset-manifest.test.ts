import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  RUNTIME_ASSET_DESTINATIONS,
  STATIC_RUNTIME_ASSETS,
  readPackageManifest,
  sharpPlatformAssets,
  sharpRuntimePackageCandidates,
} from "./runtime-asset-manifest";

const workspaceRoot = path.resolve(import.meta.dir, "../../../..");
const dockerfile = path.join(workspaceRoot, "apps/api/Dockerfile");

const resolvePackageDir = (specifier: string): string | null => {
  try {
    return path.dirname(
      realpathSync(Bun.resolveSync(`${specifier}/package.json`, workspaceRoot)),
    );
  } catch {
    return null;
  }
};

describe("runtime asset manifest", () => {
  // Runs under whatever layout the repo install uses, so an asset the image
  // needs but the lockfile no longer provides fails here, before a release.
  test("every static asset resolves and its selection exists", () => {
    for (const asset of STATIC_RUNTIME_ASSETS) {
      const dir = resolvePackageDir(asset.specifier);
      expect(dir, asset.specifier).not.toBeNull();
      expect(
        existsSync(path.join(dir ?? "", asset.select)),
        asset.specifier,
      ).toBe(true);
    }
  });

  test("sharp's runtime package and its libvips resolve for this platform", () => {
    const { packages } = sharpPlatformAssets({
      platform: process.platform,
      arch: process.arch,
      resolvePackageDir,
    });
    const runtimeCandidates = sharpRuntimePackageCandidates(
      process.platform,
      process.arch,
    );
    const runtime = packages.find((asset) =>
      runtimeCandidates.includes(asset.specifier),
    );
    expect(runtime).toBeDefined();
    // The runtime package declares its own libvips where one exists (the
    // win32 bindings bundle it); the staged set must equal that declaration.
    const runtimeDir = resolvePackageDir(runtime?.specifier ?? "");
    expect(runtimeDir).not.toBeNull();
    const declared = Object.keys(
      readPackageManifest(path.join(runtimeDir ?? "", "package.json"))
        .optionalDependencies ?? {},
    );
    expect(packages.map((asset) => asset.specifier).sort()).toEqual(
      [runtime?.specifier ?? "", ...declared].sort(),
    );
    for (const asset of packages) {
      expect(asset.destination.startsWith("node_modules/@img/")).toBe(true);
    }
  });

  test("a platform with no installed runtime package is rejected", () => {
    expect(() =>
      sharpPlatformAssets({
        platform: "plan9",
        arch: "mips",
        resolvePackageDir,
      }),
    ).toThrow(/not installed for plan9-mips/u);
  });

  // The Dockerfile copies each staged destination by hand; both sides must
  // name the same set or an asset is staged and never shipped (or shipped
  // from a path nothing stages).
  test("Dockerfile copies exactly the declared destinations", () => {
    const copied = new Set<string>();
    for (const match of readFileSync(dockerfile, "utf-8").matchAll(
      /--from=builder\s+\/app\/runtime-native\/([^\s]+)/gu,
    )) {
      copied.add((match[1] ?? "").replace(/\/$/u, ""));
    }
    expect([...copied].sort()).toEqual([...RUNTIME_ASSET_DESTINATIONS].sort());
  });
});
