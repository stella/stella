#!/usr/bin/env bun

// Whether a merge group must run the visual preview. It reads the same path
// filter GitHub applies to the workflow's pull requests, so the two cannot
// drift apart.

// The workflow runs this before installing dependencies: built-ins only.

import { readFileSync } from "node:fs";

export const VISUAL_PREVIEW_WORKFLOW = ".github/workflows/visual-preview.yml";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class PreviewScopeError extends Error {
  override name = "PreviewScopeError";
  readonly _tag = "PreviewScopeError";
}

/** The pull request path filter of the visual preview workflow. */
export const previewPaths = (workflowSource: string): string[] => {
  const workflow: unknown = Bun.YAML.parse(workflowSource);
  const on = isRecord(workflow) ? workflow["on"] : undefined;
  const pullRequest = isRecord(on) ? on["pull_request"] : undefined;
  const paths = isRecord(pullRequest) ? pullRequest["paths"] : undefined;
  if (
    !Array.isArray(paths) ||
    !paths.every((pattern) => typeof pattern === "string")
  ) {
    throw new PreviewScopeError("Missing pull_request path filter");
  }
  return paths;
};

type PreviewAffectedOptions = {
  changed: readonly string[];
  paths: readonly string[];
};

export const previewAffected = ({
  changed,
  paths,
}: PreviewAffectedOptions): boolean => {
  const globs = paths.map((pattern) => new Bun.Glob(pattern));
  return changed.some((file) => globs.some((glob) => glob.match(file)));
};

if (import.meta.main) {
  const base = process.argv[2];
  if (base === undefined || !/^[0-9a-f]{40}$/u.test(base)) {
    throw new PreviewScopeError("Expected a 40-character base sha");
  }
  const diff = Bun.spawnSync(
    ["git", "diff", "--name-only", "-z", base, "HEAD"],
    { stdout: "pipe", stderr: "inherit" },
  );
  if (diff.exitCode !== 0) {
    // The workflow treats a failed decision as "run the preview".
    throw new PreviewScopeError(`git diff ${base} HEAD failed`);
  }
  const changed = diff.stdout
    .toString()
    .split("\0")
    .filter((file) => file.length > 0);
  const paths = previewPaths(readFileSync(VISUAL_PREVIEW_WORKFLOW, "utf-8"));
  console.log(`required=${String(previewAffected({ changed, paths }))}`);
}
