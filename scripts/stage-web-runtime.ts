#!/usr/bin/env bun
// Stage the workspace packages that externalized npm dependencies of
// @stll/web import at runtime, in their published (dist) shape.
//
// Bun links workspace-published dependencies of external packages (e.g.
// @stll/folio-core -> @stll/docx-utils) to the local workspaces, so the
// production install's node_modules symlinks point into /app/packages/*.
// Those manifests export ./src/*.ts, which the runner image must not ship.
// This script derives the closure from bun.lock, runs each member's own
// `build` script (the same artifact npm publish ships), and emits
// <out>/<workspace-path>/{package.json,dist/} with the same manifest
// transformation the publish uses — a sealed artifact with no TypeScript
// source and no hand-maintained package list. apps/web/Dockerfile runs it in
// the builder stage and overlays the output onto the runner's manifest tree.

import { panic } from "better-result";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  isDistModuleEntry,
  type PublishedManifest,
  sourceExportTargets,
  toPublishedManifest,
} from "./publish-manifest";
import { findExternalRuntimeWorkspacePaths } from "./web-runtime-closure";

type StageWorkspacePackageOptions = {
  pkgDir: string;
  stagedDir: string;
};

const run = async (cmd: string[], cwd: string): Promise<void> => {
  const proc = Bun.spawn({ cmd, cwd, stderr: "inherit", stdout: "inherit" });
  if ((await proc.exited) !== 0) {
    panic(`command failed in ${cwd}: ${cmd.join(" ")}`);
  }
};

export const stageWorkspacePackage = async ({
  pkgDir,
  stagedDir,
}: StageWorkspacePackageOptions): Promise<PublishedManifest> => {
  const rawManifest = await Bun.file(path.join(pkgDir, "package.json")).json();
  // Validate the source shape before spending a build on it.
  sourceExportTargets(rawManifest);

  // Build with the package's own `build` script so the staged artifact is the
  // same one `bun publish` ships — the build config stays the package's
  // single source of truth. Do not replace this with Bun.build: independent
  // of parity, Bun's bundler currently drops re-exported implementations
  // when the entry package declares sideEffects (empty bundle with dangling
  // exports; oven-sh/bun#27709, regression in 1.3.10, still present in
  // 1.4.0-canary as of 2026-08). scripts/stage-web-runtime.test.ts fails on
  // hollow output from any builder, so a future switch stays honest.
  // --bun: run the build's node-shebang binaries (tsdown) under Bun — the
  // Docker builder image has no Node, and Bun loads .ts configs natively.
  await run([process.execPath, "run", "--bun", "build"], pkgDir);

  const manifest = toPublishedManifest(rawManifest);
  await rm(stagedDir, { force: true, recursive: true });
  await mkdir(stagedDir, { recursive: true });
  await cp(path.join(pkgDir, "dist"), path.join(stagedDir, "dist"), {
    recursive: true,
  });
  await Bun.write(
    path.join(stagedDir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // A package whose build config misses an exported entry must fail here,
  // not on the first runtime import of the missing file. Only the runtime
  // file matters: the runner image executes the package, it does not compile
  // against it, so a build that emits no declarations still stages.
  await Promise.all(
    Object.entries(manifest.exports).map(async ([subpath, entry]) => {
      const file = isDistModuleEntry(entry) ? entry.import : entry;
      const built = await Bun.file(path.join(stagedDir, file)).exists();
      if (!built) {
        panic(
          `${manifest.name}: staged export "${subpath}" is missing ${file}`,
        );
      }
    }),
  );

  return manifest;
};

if (import.meta.main) {
  const [outDir, ...flags] = process.argv.slice(2);
  if (outDir === undefined) {
    panic(
      "usage: bun scripts/stage-web-runtime.ts <out-dir> [--install-build-deps]",
    );
  }
  const repoRoot = path.resolve(import.meta.dir, "..");
  await mkdir(outDir, { recursive: true });

  const lock = Bun.JSONC.parse(
    await Bun.file(path.join(repoRoot, "bun.lock")).text(),
  );
  const workspacePaths = findExternalRuntimeWorkspacePaths(lock);

  // The Docker builder installs with `--filter @stll/web`, which omits the
  // closure members' devDependencies (their build toolchain). Widen that
  // install to the derived closure; additive, so it must include the filters
  // the base install used.
  if (flags.includes("--install-build-deps") && workspacePaths.length > 0) {
    const memberNames = await Promise.all(
      workspacePaths.map(async (workspacePath) => {
        const manifest = await Bun.file(
          path.join(repoRoot, workspacePath, "package.json"),
        ).json();
        return typeof manifest.name === "string"
          ? manifest.name
          : panic(`${workspacePath}/package.json has no name`);
      }),
    );
    await run(
      [
        process.execPath,
        "install",
        "--filter",
        "@stll/web",
        ...memberNames.flatMap((name) => ["--filter", name]),
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
      repoRoot,
    );
  }

  await Promise.all(
    workspacePaths.map(async (workspacePath) => {
      const manifest = await stageWorkspacePackage({
        pkgDir: path.join(repoRoot, workspacePath),
        stagedDir: path.join(outDir, workspacePath),
      });
      console.log(
        `staged ${manifest.name}@${manifest.version} -> ${workspacePath} (exports -> dist)`,
      );
    }),
  );
  if (workspacePaths.length === 0) {
    console.log(
      "no workspace packages reached by externalized runtime dependencies",
    );
  }
}
