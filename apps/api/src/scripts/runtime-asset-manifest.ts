import { panic } from "better-result";
/**
 * Native and binary assets the runtime image ships outside any node_modules.
 *
 * The runner stage carries compiled bundles only, so every file a bundle
 * loads at runtime by path (native addons, wasm, platform bindings) has to be
 * placed by hand. Each entry here is resolved through Bun's module resolver at
 * build time and copied with symlinks dereferenced, so the image never depends
 * on how the install laid node_modules out (hoisted, isolated, global store).
 *
 * `destination` is relative to the staging root; the Dockerfile copies each
 * staged directory from there. The manifest test asserts the two sets match.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export type RuntimeAsset = {
  /** Package whose files are staged; resolved via `<specifier>/package.json`. */
  specifier: string;
  /** Path inside the resolved package to copy; `.` copies the whole package. */
  select: string;
  /** Path under the staging root. */
  destination: string;
};

/** Assets with a fixed package and path. */
export const STATIC_RUNTIME_ASSETS = [
  // The bundled OCR worker dlopens onnxruntime from `../bin` relative to the
  // workers directory.
  { specifier: "onnxruntime-node", select: "bin", destination: "bin" },
  // @stll/anonymize-wasm loads its native glue via ESM import(), which a
  // compiled binary resolves against its embedded filesystem only; the
  // loader is pointed at this directory instead.
  {
    specifier: "@stll/anonymize-wasm",
    select: "dist/native",
    destination: "anonymize-native",
  },
  // quickjs-emscripten reads this wasm file from the compiled binary's
  // `$bunfs/root` asset directory.
  {
    specifier: "@jitl/quickjs-wasmfile-release-asyncify",
    select: "dist/emscripten-module.wasm",
    destination: "quickjs/emscripten-module.wasm",
  },
] as const satisfies readonly RuntimeAsset[];

/**
 * Where sharp's platform packages are staged. The worker bundle requires
 * `@img/...` bare, so a node_modules directory beside the worker bundles has
 * to satisfy that lookup.
 */
export const SHARP_PLATFORM_DESTINATION = "node_modules/@img";

/** Every destination the Dockerfile must copy out of the staging root. */
export const RUNTIME_ASSET_DESTINATIONS = [
  ...STATIC_RUNTIME_ASSETS.map((asset) => asset.destination),
  SHARP_PLATFORM_DESTINATION,
] as const;

type PackageManifest = {
  optionalDependencies?: Record<string, string>;
};

export const readPackageManifest = (file: string): PackageManifest => {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
  if (typeof parsed !== "object" || parsed === null) {
    panic(`${file} is not a package manifest`);
  }
  return parsed;
};

/**
 * sharp's runtime package for this platform and libc, as sharp names them:
 * `@img/sharp-<os>-<arch>` on glibc, `@img/sharp-<os>musl-<arch>` on musl.
 * Both spellings are tried; the installer only materializes the one that
 * matches the build image, so exactly one resolves.
 */
export const sharpRuntimePackageCandidates = (
  platform: string,
  arch: string,
): readonly string[] => [
  `@img/sharp-${platform}-${arch}`,
  `@img/sharp-${platform}musl-${arch}`,
];

export type SharpPlatformAssets = {
  /** Resolved runtime package and everything it declares optional. */
  packages: readonly { specifier: string; select: "."; destination: string }[];
};

export type ResolvePackageDir = (specifier: string) => string | null;

/**
 * The sharp packages this platform needs: the runtime binding plus its own
 * optional dependencies (libvips). Derived from the manifests, not from a
 * hand list, so a sharp upgrade that moves libvips does not need a code change.
 */
export const sharpPlatformAssets = ({
  platform,
  arch,
  resolvePackageDir,
}: {
  platform: string;
  arch: string;
  resolvePackageDir: ResolvePackageDir;
}): SharpPlatformAssets => {
  const candidates = sharpRuntimePackageCandidates(platform, arch);
  const runtime = candidates
    .map((specifier) => {
      const dir = resolvePackageDir(specifier);
      return dir === null ? null : { specifier, dir };
    })
    .find((entry) => entry !== null);
  if (runtime === undefined) {
    panic(
      `sharp runtime package not installed for ${platform}-${arch}; tried ${candidates.join(", ")}`,
    );
  }
  const manifest = readPackageManifest(path.join(runtime.dir, "package.json"));
  const optional = Object.keys(manifest.optionalDependencies ?? {});
  const packages = [runtime.specifier, ...optional].map((specifier) => {
    if (resolvePackageDir(specifier) === null) {
      panic(
        `${specifier} is declared by ${runtime.specifier} but is not installed`,
      );
    }
    return {
      specifier,
      select: "." as const,
      destination: path.posix.join(
        SHARP_PLATFORM_DESTINATION,
        specifier.replace(/^@img\//u, ""),
      ),
    };
  });
  return { packages };
};
