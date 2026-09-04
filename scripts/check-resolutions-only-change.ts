#!/usr/bin/env bun
// Autofix boundary: the workflow may push a root package.json edit ONLY when
// that edit is an override pin raised to a dependent's floor. Everything else —
// a new dependency, a changed script, a reordered key, a reformat, a lowered
// pin — is a change the autofix has no mandate to make on a Dependabot PR, and
// fails the job.
//
// The verdict is structural, not textual: the pin changes are replayed onto the
// committed manifest and the result must equal the working tree byte for byte,
// so no unrelated byte can ride along.

import path from "node:path";

import { inspectManifestChange } from "./resolution-ranges";

const ROOT = path.resolve(import.meta.dir, "..");
const REF_PATTERN = /^(?:HEAD|[0-9a-f]{40})$/u;
const REGULAR_FILE_MODE = "100644";
const MANIFEST = "package.json";

class ResolutionChangeCheckError extends Error {
  readonly _tag = "ResolutionChangeCheckError";

  constructor(message: string) {
    super(message);
    this.name = "ResolutionChangeCheckError";
  }
}

const gitOutput = (args: readonly string[], root: string): string => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new ResolutionChangeCheckError(`git ${args.join(" ")} failed`);
  }
  return result.stdout.toString();
};

const parseRef = (args: readonly string[]): string => {
  if (args.length === 0) {
    return "HEAD";
  }
  const [flag, value, ...rest] = args;
  if (flag !== "--ref" || value === undefined || rest.length > 0) {
    throw new ResolutionChangeCheckError(
      "Usage: check-resolutions-only-change.ts [--ref <sha>]",
    );
  }
  if (!REF_PATTERN.test(value)) {
    throw new ResolutionChangeCheckError(
      `Refusing to compare against ${value}: expected HEAD or a full commit SHA`,
    );
  }
  return value;
};

export const runCheckResolutionsOnlyChange = async (
  args: readonly string[],
  root: string = ROOT,
): Promise<number> => {
  const ref = parseRef(args);
  // A PR that turns package.json into a symlink would otherwise have the fixer
  // write through it; only a regular tracked blob is comparable.
  const entry = gitOutput(["ls-tree", "-z", ref, "--", MANIFEST], root);
  if (entry.slice(0, entry.indexOf(" ")) !== REGULAR_FILE_MODE) {
    throw new ResolutionChangeCheckError(
      `${MANIFEST} at ${ref} is not a regular file`,
    );
  }
  const committed = gitOutput(["show", `${ref}:${MANIFEST}`], root);
  const working = await Bun.file(path.join(root, MANIFEST)).text();

  const verdict = inspectManifestChange(committed, working);
  switch (verdict.status) {
    case "unchanged":
      process.stdout.write("package.json guard: unchanged. OK.\n");
      return 0;
    case "pins-raised":
      process.stdout.write(
        [
          ...verdict.changes.map(
            ({ from, kind, packageName, to }) =>
              `package.json guard: ${kind}.${packageName} raised ${from} -> ${to}.`,
          ),
          "package.json guard: only raised pins changed. OK.",
          "",
        ].join("\n"),
      );
      return 0;
    case "rejected":
      process.stderr.write(
        `package.json guard: ${verdict.reason}. Only a raised root resolution may be generated here.\n`,
      );
      return 1;
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
};

if (import.meta.main) {
  process.exit(await runCheckResolutionsOnlyChange(process.argv.slice(2)));
}
