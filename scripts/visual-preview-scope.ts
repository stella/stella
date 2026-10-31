#!/usr/bin/env bun

// Whether a merge group must run the visual preview. It reads the same path
// filter GitHub applies to the workflow's pull requests, so the two cannot
// drift apart.

import { panic } from "better-result";
import { readFileSync } from "node:fs";
import * as v from "valibot";

export const VISUAL_PREVIEW_WORKFLOW = ".github/workflows/visual-preview.yml";

const workflowSchema = v.looseObject({
  on: v.looseObject({
    pull_request: v.looseObject({ paths: v.array(v.string()) }),
  }),
});

/** The pull request path filter of the visual preview workflow. */
export const previewPaths = (workflowSource: string): string[] =>
  v.parse(workflowSchema, Bun.YAML.parse(workflowSource)).on.pull_request.paths;

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
  const base = v.parse(
    v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
    process.argv[2],
  );
  const diff = Bun.spawnSync(
    ["git", "diff", "--name-only", "-z", base, "HEAD"],
    { stdout: "pipe", stderr: "inherit" },
  );
  if (diff.exitCode !== 0) {
    // The workflow treats a failed decision as "run the preview".
    panic(`git diff ${base} HEAD failed`);
  }
  const changed = diff.stdout
    .toString()
    .split("\0")
    .filter((file) => file.length > 0);
  const paths = previewPaths(readFileSync(VISUAL_PREVIEW_WORKFLOW, "utf-8"));
  console.log(`required=${String(previewAffected({ changed, paths }))}`);
}
