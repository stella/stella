/**
 * Guard: joining the `better-result` boundary convention is the default.
 *
 * The convention is enforced per directory (`RESULT_CONVENTION_ENABLED_GLOBS`
 * in scripts/result-boundary-globs.ts) because the tree still carries throw and
 * try/catch debt the ratchet is walking down. An enable list on its own decays
 * silently: a new app, a new package, or a new feature directory is simply
 * absent from it, nothing fails, and the convention quietly stops applying to
 * the newest code in the repository.
 *
 * This guard inverts that. It enumerates every enrolment unit under
 * `apps/<name>/src` and `packages/<name>/src` and fails unless the unit is
 * either enabled or listed in `RESULT_CONVENTION_OPT_OUTS` with a written
 * reason. A stale opt-out fails too, so the table can only shrink.
 *
 * An enrolment unit is the directory the enable list makes decisions at: a
 * `packages/<name>/src` root, or a directory up to two levels under an
 * `apps/<name>/src` root (`apps/api/src/handlers/files`,
 * `apps/web/src/components/chat`). Files deeper than that belong to their
 * two-level ancestor; files directly in the root belong to the root.
 *
 * Run: `bun scripts/check-result-boundary-enrolment.ts`
 */

import path from "node:path";

import {
  isResultConventionExcludedFile,
  RESULT_CONVENTION_ENABLED_GLOBS,
  RESULT_CONVENTION_OPT_OUTS,
  type ResultBoundaryOptOut,
} from "./result-boundary-globs.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const GLOBS_MODULE = "scripts/result-boundary-globs.ts";

const APP_UNIT_DEPTH = 2;
const PACKAGE_UNIT_DEPTH = 0;
const SOURCE_FILE = /\.tsx?$/u;

/**
 * The enrolment unit a source file belongs to, or `undefined` for a path that
 * is not workspace source (`apps/<name>/src/...`, `packages/<name>/src/...`).
 */
export const resultConventionUnit = (file: string): string | undefined => {
  const [workspaceKind, workspace, src, ...inside] = file.split("/");
  if (
    (workspaceKind !== "apps" && workspaceKind !== "packages") ||
    workspace === undefined ||
    src !== "src" ||
    inside.length === 0
  ) {
    return undefined;
  }

  const root = `${workspaceKind}/${workspace}/src`;
  const depth = workspaceKind === "apps" ? APP_UNIT_DEPTH : PACKAGE_UNIT_DEPTH;
  const directories = inside.slice(0, -1).slice(0, depth);
  return directories.length === 0 ? root : `${root}/${directories.join("/")}`;
};

type EnrolmentInput = {
  enabledGlobs: readonly string[];
  files: readonly string[];
  isExcluded: (file: string) => boolean;
  optOuts: readonly ResultBoundaryOptOut[];
};

type EnrolmentReport = {
  enabledUnits: number;
  errors: string[];
  optedOutUnits: number;
};

export const checkResultBoundaryEnrolment = ({
  enabledGlobs,
  files,
  isExcluded,
  optOuts,
}: EnrolmentInput): EnrolmentReport => {
  // Every glob is tested, never short-circuited: an enabled glob that matches
  // nothing is a directory that was deleted or renamed, and the convention
  // silently stopped applying to whatever replaced it.
  const enabled = enabledGlobs.map((pattern) => ({
    glob: new Bun.Glob(pattern),
    matched: false,
    pattern,
  }));
  const isEnabled = (file: string): boolean => {
    let covered = false;
    for (const entry of enabled) {
      if (entry.glob.match(file)) {
        entry.matched = true;
        covered = true;
      }
    }
    return covered;
  };

  // A unit is enrolled only when the convention covers every file it owns, so
  // a half-covered directory reads as unenrolled rather than as done.
  const coverage = new Map<string, { covered: number; total: number }>();
  for (const file of files) {
    if (!SOURCE_FILE.test(file) || isExcluded(file)) {
      continue;
    }
    const unit = resultConventionUnit(file);
    if (unit === undefined) {
      continue;
    }
    const seen = coverage.get(unit) ?? { covered: 0, total: 0 };
    coverage.set(unit, {
      covered: seen.covered + (isEnabled(file) ? 1 : 0),
      total: seen.total + 1,
    });
  }

  const errors: string[] = [];
  for (const { matched, pattern } of enabled) {
    if (!matched) {
      errors.push(
        `${GLOBS_MODULE}: enabled glob "${pattern}" matches no source file; ` +
          `its directory was removed or renamed, so the convention no longer ` +
          `covers anything there. Point the glob at the new path or delete it.`,
      );
    }
  }

  const optedOut = new Map<string, string>();
  for (const { reason, unit } of optOuts) {
    if (optedOut.has(unit)) {
      errors.push(`${GLOBS_MODULE}: duplicate opt-out for "${unit}"`);
      continue;
    }
    if (reason.trim() === "") {
      errors.push(
        `${GLOBS_MODULE}: opt-out for "${unit}" has no reason; write one, ` +
          `or "unreviewed" when nobody has looked yet`,
      );
    }
    optedOut.set(unit, reason);
  }

  let enabledUnits = 0;
  const byUnit = [...coverage.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [unit, { covered, total }] of byUnit) {
    if (covered === total) {
      enabledUnits += 1;
      if (optedOut.has(unit)) {
        errors.push(
          `${GLOBS_MODULE}: "${unit}" is enabled, so its opt-out is stale; ` +
            `delete the entry`,
        );
      }
      continue;
    }
    if (optedOut.has(unit)) {
      continue;
    }
    errors.push(
      `${unit}: ${total - covered} of ${total} source file(s) are outside the ` +
        `better-result boundary convention. Add the directory to ` +
        `RESULT_CONVENTION_ENABLED_GLOBS once it reports no ` +
        `no-throw-outside-boundary / no-try-catch-outside-boundary ` +
        `violations, or record it in RESULT_CONVENTION_OPT_OUTS with a reason.`,
    );
  }

  for (const unit of optedOut.keys()) {
    if (!coverage.has(unit)) {
      errors.push(
        `${GLOBS_MODULE}: opt-out for "${unit}" names no source directory; ` +
          `delete the entry`,
      );
    }
  }

  return { enabledUnits, errors, optedOutUnits: optedOut.size };
};

const trackedWorkspaceFiles = (): string[] => {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--", "apps", "packages"],
    { cwd: REPO_ROOT },
  );
  if (!listed.success) {
    console.error("git ls-files failed; cannot enumerate workspace source");
    process.exit(1);
  }
  return listed.stdout.toString().split("\0").filter(Boolean);
};

const main = () => {
  const { enabledUnits, errors, optedOutUnits } = checkResultBoundaryEnrolment({
    enabledGlobs: RESULT_CONVENTION_ENABLED_GLOBS,
    files: trackedWorkspaceFiles(),
    isExcluded: isResultConventionExcludedFile,
    optOuts: RESULT_CONVENTION_OPT_OUTS,
  });

  if (errors.length > 0) {
    console.error(errors.join("\n\n"));
    process.exit(1);
  }

  console.log(
    `better-result boundary: ${enabledUnits} enrolled directories, ` +
      `${optedOutUnits} opted out with a reason.`,
  );
};

if (import.meta.main) {
  main();
}
