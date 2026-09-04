import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import formatterConfig from "../.oxfmtrc.json" with { type: "json" };
import rootPackage from "../package.json" with { type: "json" };

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const FORMAT_RUNNER_PATH = path.join(REPO_ROOT, "scripts/run-oxfmt.ts");
const SAFE_FORMAT_ARGUMENTS = /^(?: [A-Za-z0-9_./][A-Za-z0-9_./-]*)*$/u;
const tailwindStylesheet = path.resolve(
  REPO_ROOT,
  formatterConfig.sortTailwindcss.stylesheet,
);

const readFormatCommand = (manifestPath: string): unknown => {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("scripts" in manifest)
  ) {
    return undefined;
  }

  const { scripts } = manifest;
  if (
    typeof scripts !== "object" ||
    scripts === null ||
    !("format" in scripts)
  ) {
    return undefined;
  }

  return scripts.format;
};

const workspaceFormatCommandErrors = () => {
  const errors: string[] = [];

  for (const workspacePattern of rootPackage.workspaces) {
    const manifestGlob = new Bun.Glob(`${workspacePattern}/package.json`);

    for (const relativeManifestPath of manifestGlob.scanSync({
      cwd: REPO_ROOT,
      onlyFiles: true,
    })) {
      const manifestPath = path.join(REPO_ROOT, relativeManifestPath);
      const formatCommand = readFormatCommand(manifestPath);
      const relativeRunnerPath = path
        .relative(path.dirname(manifestPath), FORMAT_RUNNER_PATH)
        .split(path.sep)
        .join("/");
      const expectedFormatRunner = `bun ${relativeRunnerPath}`;
      if (typeof formatCommand !== "string") {
        errors.push(
          `${relativeManifestPath} must define scripts.format through ${expectedFormatRunner}`,
        );
        continue;
      }
      if (
        formatCommand.startsWith(expectedFormatRunner) &&
        SAFE_FORMAT_ARGUMENTS.test(
          formatCommand.slice(expectedFormatRunner.length),
        )
      ) {
        continue;
      }

      errors.push(
        `${relativeManifestPath} must route its format script through ${expectedFormatRunner}`,
      );
    }
  }

  return errors;
};

export const requireFormatterEnvironment = () => {
  const errors = workspaceFormatCommandErrors();

  if (!existsSync(tailwindStylesheet)) {
    errors.push(
      "Formatter dependencies are incomplete. Run `bun install --frozen-lockfile` before formatting.",
    );
  }

  if (errors.length === 0) {
    return;
  }

  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
};

if (import.meta.main) {
  requireFormatterEnvironment();
}
