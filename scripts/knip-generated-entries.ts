#!/usr/bin/env bun

import { panic, TaggedError } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { CI_GENERATED_OUTPUTS } from "../packages/scripts/src/generated-files";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const GENERATED_PATH_MARKER = ".gen.";

// Keep the path owned by the generator registry; the census below binds that
// registry to every generated entry or project path configured in knip.json.
export const KNIP_GENERATED_ENTRY_FILES = [
  ...CI_GENERATED_OUTPUTS.routeTree,
] as const;

export class KnipGeneratedEntriesMissingError extends TaggedError(
  "KnipGeneratedEntriesMissingError",
)<{
  message: string;
  missingFiles: readonly string[];
}> {}

const stringList = (value: unknown): readonly string[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    panic("knip entry and project values must be string arrays");
  }
  return value;
};

export const generatedKnipConfigPaths = (source: string): readonly string[] => {
  const parsed: unknown = Bun.JSONC.parse(source);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("workspaces" in parsed)
  ) {
    panic("knip.json must contain a workspaces object");
  }
  const workspaces = parsed.workspaces;
  if (typeof workspaces !== "object" || workspaces === null) {
    panic("knip.json workspaces must be an object");
  }

  const generated: string[] = [];
  for (const [workspace, config] of Object.entries(workspaces)) {
    if (typeof config !== "object" || config === null) {
      continue;
    }
    const entry = "entry" in config ? stringList(config.entry) : [];
    const project = "project" in config ? stringList(config.project) : [];
    for (const configuredPath of [...entry, ...project]) {
      const relativePath = configuredPath.replace(/!$/u, "");
      if (relativePath.includes(GENERATED_PATH_MARKER)) {
        generated.push(
          workspace === "." ? relativePath : `${workspace}/${relativePath}`,
        );
      }
    }
  }
  return generated.toSorted();
};

export const findMissingKnipGeneratedEntries = (
  repoRoot = REPO_ROOT,
  fileExists: (file: string) => boolean = existsSync,
): readonly string[] =>
  KNIP_GENERATED_ENTRY_FILES.filter(
    (file) => !fileExists(path.join(repoRoot, file)),
  );

export const validateKnipGeneratedEntries = (
  repoRoot = REPO_ROOT,
  fileExists: (file: string) => boolean = existsSync,
): KnipGeneratedEntriesMissingError | undefined => {
  const missingFiles = findMissingKnipGeneratedEntries(repoRoot, fileExists);
  if (missingFiles.length === 0) {
    return undefined;
  }
  return new KnipGeneratedEntriesMissingError({
    missingFiles,
    message: `Required generated knip entries are missing:\n${missingFiles.map((file) => `  ${file}`).join("\n")}\nRun \`bun run generate\` and retry.`,
  });
};

export const reportMissingKnipGeneratedEntries = (
  repoRoot = REPO_ROOT,
): number => {
  const error = validateKnipGeneratedEntries(repoRoot);
  if (error === undefined) {
    return 0;
  }
  console.error(`${error._tag}: ${error.message}`);
  return 1;
};

if (import.meta.main) {
  process.exit(reportMissingKnipGeneratedEntries());
}

export const readConfiguredGeneratedKnipPaths = (
  repoRoot = REPO_ROOT,
): readonly string[] =>
  generatedKnipConfigPaths(
    readFileSync(path.join(repoRoot, "knip.json"), "utf-8"),
  );
