import { loadDeclarationDirectory } from "./ownership-loader.ts";

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
// edit the same file.
export const GUARD_ROLLOUT_DIRECTORY = "scripts/guard-rollouts";

export const guardRolloutSource = (id: string) =>
  `${GUARD_ROLLOUT_DIRECTORY}/${id}.ts`;

export const GUARD_ROLLOUTS = loadDeclarationDirectory<GuardRollout>(
  new URL("guard-rollouts/", import.meta.url),
  "guard rollout",
);
