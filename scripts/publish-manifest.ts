// Transform a package.json from its in-repo "source" shape to the published
// "dist" shape.
//
// The monorepo consumes these packages from source: `exports` point at
// `./src/*.ts`, so every consumer (Bun, tsgo, Vite) resolves source directly
// with no aliases or conditions. The published package must instead expose the
// built artifacts — real `.d.ts` + `.js`, no source — so external consumers do
// not depend on our `.ts` or our bundler resolution.
//
// Shared by scripts/prepare-publish.ts (npm publish) and
// scripts/stage-web-runtime.ts (web runner image staging).

import { panic } from "better-result";

type DistEntry = { types: string; import: string };

export type PublishedManifest = Record<string, unknown> & {
  exports: Record<string, DistEntry>;
  name: string;
  version: string;
};

// "./src/model/document.ts" -> "./dist/model/document"
const distBase = (srcPath: string): string =>
  srcPath.replace(/^\.\/src\//u, "./dist/").replace(/\.ts$/u, "");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Validated `exports` map of a source-shaped manifest: subpath -> ./src/*.ts.
export const sourceExportTargets = (
  manifest: unknown,
): Record<string, string> => {
  if (!isRecord(manifest) || typeof manifest["name"] !== "string") {
    panic("package.json must be an object with a name");
  }
  const exportsField = manifest["exports"];
  if (!isRecord(exportsField)) {
    panic(`${manifest["name"]}: exports must be an object`);
  }

  const targets: Record<string, string> = {};
  for (const [subpath, target] of Object.entries(exportsField)) {
    if (
      typeof target !== "string" ||
      !target.startsWith("./src/") ||
      !target.endsWith(".ts")
    ) {
      panic(
        `${manifest["name"]}: expected source export "${subpath}" to be a ./src/*.ts string, got ${JSON.stringify(target)}`,
      );
    }
    targets[subpath] = target;
  }
  return targets;
};

export const toPublishedManifest = (manifest: unknown): PublishedManifest => {
  const sourceTargets = sourceExportTargets(manifest);
  if (!isRecord(manifest) || typeof manifest["name"] !== "string") {
    panic("package.json must be an object with a name");
  }
  if (typeof manifest["version"] !== "string") {
    panic(`${manifest["name"]}: package.json must have a version`);
  }

  const distExports: Record<string, DistEntry> = {};
  for (const [subpath, target] of Object.entries(sourceTargets)) {
    const base = distBase(target);
    distExports[subpath] = { types: `${base}.d.ts`, import: `${base}.js` };
  }

  const root =
    distExports["."] ??
    panic(`${manifest["name"]}: exports must include a "." entry`);

  // Ship built artifacts and the README; drop `src`. Carry over any non-`src`
  // asset dirs the source `files` allowlist opted in (e.g. TanStack Intent's
  // `skills/`), so published tarballs keep shipping them.
  const carried = Array.isArray(manifest["files"])
    ? manifest["files"].filter(
        (entry: unknown): entry is string =>
          typeof entry === "string" &&
          entry !== "src" &&
          entry !== "dist" &&
          entry !== "README.md",
      )
    : [];

  return {
    ...manifest,
    exports: distExports,
    files: ["dist", "README.md", ...carried],
    main: root.import,
    name: manifest["name"],
    types: root.types,
    version: manifest["version"],
  };
};
