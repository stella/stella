#!/usr/bin/env bun
// Transform a package.json from its in-repo "source" shape to the published
// "dist" shape, in place.
//
// The monorepo consumes these packages from source: `exports` point at
// `./src/*.ts`, so every consumer (Bun, tgo, Vite) resolves source directly
// with no aliases or conditions. The published package must instead expose the
// built artifacts — real `.d.ts` + `.js`, no source — so external consumers do
// not depend on our `.ts` or our bundler resolution.
//
// Run this after `bun run build`, immediately before `bun pm pack` /
// `bun publish`. It rewrites `exports` (deriving each dist target from the
// source path), `main`, `types`, and `files`. Restore the working tree
// afterward (`git checkout -- package.json`) — the publish workflow runs on an
// ephemeral checkout; the bootstrap script restores explicitly.

import { panic } from "better-result";
import path from "node:path";

type DistEntry = { types: string; import: string };

const pkgDir =
  process.argv[2] ??
  panic("usage: bun scripts/prepare-publish.ts <package-dir>");

const pkgPath = path.resolve(pkgDir, "package.json");
const pkg = await Bun.file(pkgPath).json();

// "./src/model/document.ts" -> "./dist/model/document"
const distBase = (srcPath: string): string =>
  srcPath.replace(/^\.\/src\//u, "./dist/").replace(/\.ts$/u, "");

const distExports: Record<string, DistEntry> = {};
for (const [subpath, target] of Object.entries(pkg.exports)) {
  if (typeof target !== "string" || !target.startsWith("./src/")) {
    panic(
      `${pkg.name}: expected source export "${subpath}" to be a ./src/*.ts string, got ${JSON.stringify(target)}`,
    );
  }
  const base = distBase(target);
  distExports[subpath] = { types: `${base}.d.ts`, import: `${base}.js` };
}

const root =
  distExports["."] ?? panic(`${pkg.name}: exports must include a "." entry`);

pkg.exports = distExports;
pkg.main = root.import;
pkg.types = root.types;
pkg.files = ["dist", "README.md"];

await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(
  `prepared ${pkg.name}@${pkg.version} for publish (exports -> dist)`,
);
