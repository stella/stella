/**
 * Command line for the quarantine exclude guard in
 * `check-stll-quarantine-excludes.ts`. Git reads live here so the guard
 * module stays importable by offline checks.
 *
 * Run: `bun scripts/check-stll-quarantine-excludes-cli.ts [--prune]`
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BUNFIG,
  checkQuarantineExcludes,
  LOCKFILE,
  pruneQuarantineBunfigs,
  quarantineBunfigFiles,
  RELEASE_AGE_EXCEPTION_SOURCES,
  REPO_ROOT,
} from "./check-stll-quarantine-excludes";
import { trackedPolicyFiles } from "./dated-waiver-tracked-files";
import {
  ExpiryScopeError,
  expiryWarning,
  type ExpiryCheckScope,
} from "./expiry-check-scope";
import { readExpiryCheckScope } from "./expiry-check-scope-git";

const readBasePackageManifests = (
  scope: ExpiryCheckScope,
): Record<string, string> => {
  if (scope.type === "all" || scope.baseSha === undefined) {
    return {};
  }
  const listed = Bun.spawnSync(
    ["git", "ls-tree", "-r", "--name-only", "-z", scope.baseSha],
    { cwd: REPO_ROOT },
  );
  if (listed.exitCode !== 0) {
    throw new ExpiryScopeError(
      "Cannot enumerate base manifests for expiry ownership",
    );
  }
  const files = listed.stdout
    .toString()
    .split("\0")
    .filter(
      (file) =>
        scope.changedFiles.has(file) &&
        path.posix.basename(file) === "package.json",
    );
  return Object.fromEntries(
    files.map((file) => {
      const contents = Bun.spawnSync(
        ["git", "show", `${scope.baseSha}:${file}`],
        { cwd: REPO_ROOT },
      );
      if (contents.exitCode !== 0) {
        throw new ExpiryScopeError(
          "Cannot read base manifest for expiry ownership",
        );
      }
      return [file, contents.stdout.toString()];
    }),
  );
};

const main = () => {
  const tracked = trackedPolicyFiles();
  const bunfigFiles = quarantineBunfigFiles(tracked);
  const bunfigs = Object.fromEntries(
    bunfigFiles.map((file) => [
      file,
      readFileSync(path.join(REPO_ROOT, file), "utf-8"),
    ]),
  );
  if (process.argv.includes("--prune")) {
    for (const [file, result] of Object.entries(
      pruneQuarantineBunfigs({ bunfigs }),
    )) {
      if (result.pruned.length === 0) {
        continue;
      }
      writeFileSync(path.join(REPO_ROOT, file), result.bunfig);
      console.log(
        `${file}: removed expired quarantine excludes: ${result.pruned.join(", ")}.`,
      );
    }
    return;
  }
  const scope = readExpiryCheckScope();
  const basePackageManifests = readBasePackageManifests(scope);
  const errors: string[] = [];
  for (const [file, bunfig] of Object.entries(bunfigs)) {
    const dir = path.posix.dirname(file);
    const lockfile = dir === "." ? LOCKFILE : `${dir}/${LOCKFILE}`;
    const manifests = tracked.filter(
      (manifest) =>
        path.posix.basename(manifest) === "package.json" &&
        (dir === "." || manifest.startsWith(`${dir}/`)),
    );
    const result = checkQuarantineExcludes({
      bunfig,
      bunfigFile: file,
      lockfile: tracked.includes(lockfile)
        ? readFileSync(path.join(REPO_ROOT, lockfile), "utf-8")
        : "",
      owningFiles: [file, lockfile],
      basePackageManifests,
      packageManifests: Object.fromEntries(
        manifests.map((manifest) => [
          manifest,
          readFileSync(path.join(REPO_ROOT, manifest), "utf-8"),
        ]),
      ),
      scope,
      releaseAgeExceptionSources:
        file === BUNFIG
          ? Object.fromEntries(
              RELEASE_AGE_EXCEPTION_SOURCES.map((source) => [
                source,
                readFileSync(path.join(REPO_ROOT, source), "utf-8"),
              ]),
            )
          : {},
    });
    errors.push(
      ...result.errors.map((error) =>
        error.startsWith(`${BUNFIG} `)
          ? file + error.slice(BUNFIG.length)
          : error,
      ),
    );
    for (const warning of result.warnings) {
      console.warn(expiryWarning(warning));
    }
  }
  if (errors.length > 0) {
    console.error(errors.join("\n\n"));
    process.exit(1);
  }
  console.log("Quarantine excludes satisfy installation policy.");
};

if (import.meta.main) {
  main();
}
