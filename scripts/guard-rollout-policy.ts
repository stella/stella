import { fail as panic } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";

export type GuardRollout = {
  id: string;
  check: readonly string[];
  rules?: readonly string[];
} & (
  | { type: "changed-lines"; expiresAt: string }
  | { type: "full" }
  | { type: "autofix"; generator: string }
);

// One rollout per file, so adding independent guards never edits a shared index.
export const GUARD_ROLLOUT_DIRECTORY = "scripts/guard-rollouts";

export const guardRolloutSource = (id: string) =>
  `${GUARD_ROLLOUT_DIRECTORY}/${id}.json`;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isGuardRollout = (value: unknown): value is GuardRollout => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("check" in value) ||
    !isStringArray(value.check) ||
    ("rules" in value && !isStringArray(value.rules)) ||
    !("type" in value)
  ) {
    return false;
  }
  switch (value.type) {
    case "full":
      return true;
    case "changed-lines":
      return "expiresAt" in value && typeof value.expiresAt === "string";
    case "autofix":
      return "generator" in value && typeof value.generator === "string";
    default:
      return false;
  }
};

const loadedFiles = new Map<string, GuardRollout>();
for (const file of readdirSync(
  new URL("guard-rollouts/", import.meta.url),
).toSorted()) {
  if (!file.endsWith(".json")) {
    continue;
  }
  const source = `${GUARD_ROLLOUT_DIRECTORY}/${file}`;
  const id = /^([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)\.json$/u.exec(file)?.[1];
  if (id === undefined) {
    panic(`guard rollout file must be <kebab-case-id>.json: ${source}`);
  }
  const url = new URL(`guard-rollouts/${file}`, import.meta.url);
  let rollout: unknown;
  try {
    rollout = JSON.parse(readFileSync(url, "utf-8"));
  } catch (error) {
    panic(`Cannot load guard rollout ${source}: ${String(error)}`);
  }
  if (!isGuardRollout(rollout)) {
    panic(`Invalid guard rollout: ${source}`);
  }
  if (rollout.id !== id) {
    panic(`guard rollout filename must match id: ${source} (${rollout.id})`);
  }
  loadedFiles.set(id, rollout);
}

export const GUARD_ROLLOUT_FILES = Object.fromEntries(loadedFiles);

// Ids are unique because file names are: a second file declaring an existing
// id fails here as a mismatch.
export const guardRolloutsFromFiles = (
  files: Readonly<Record<string, GuardRollout>>,
): readonly GuardRollout[] =>
  Object.entries(files).map(([file, rollout]) =>
    rollout.id === file
      ? rollout
      : panic(
          `guard rollout filename must match id: ${file}.json (${rollout.id})`,
        ),
  );

export const GUARD_ROLLOUTS = guardRolloutsFromFiles(GUARD_ROLLOUT_FILES);
