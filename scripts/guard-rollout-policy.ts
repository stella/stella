import { panic } from "better-result";

import { GUARD_ROLLOUT_FILES } from "./guard-rollouts.gen.ts";

export type GuardRollout = {
  id: string;
  check: readonly string[];
  rules?: readonly string[];
} & (
  | { type: "changed-lines"; expiresAt: string }
  | { type: "full" }
  | { type: "autofix"; generator: string }
);

// One rollout per file, so pull requests that add rules in parallel never
// edit the same file. scripts/generate-guard-rollouts.ts lists them in
// scripts/guard-rollouts.gen.ts.
export const GUARD_ROLLOUT_DIRECTORY = "scripts/guard-rollouts";

export const guardRolloutSource = (id: string) =>
  `${GUARD_ROLLOUT_DIRECTORY}/${id}.ts`;

// Ids are unique because file names are: a second file declaring an existing
// id fails here as a mismatch.
export const guardRolloutsFromFiles = (
  files: Readonly<Record<string, GuardRollout>>,
): readonly GuardRollout[] =>
  Object.entries(files).map(([file, rollout]) =>
    rollout.id === file
      ? rollout
      : panic(
          `guard rollout filename must match id: ${file}.ts (${rollout.id})`,
        ),
  );

export const GUARD_ROLLOUTS = guardRolloutsFromFiles(GUARD_ROLLOUT_FILES);
