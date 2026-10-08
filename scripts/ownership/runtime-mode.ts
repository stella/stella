import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "runtime-mode",
  capability:
    "Server runtime mode: strict, or open to local development capabilities",
  owner: ["packages/runtime-mode/"],
  summary:
    "`@stll/runtime-mode` is the one reader of `NODE_ENV` and " +
    "`STELLA_LOCAL_DEV`. A process is open only with a local `NODE_ENV`, " +
    "`STELLA_LOCAL_DEV=1` and a build that is not a release; an opt-in it " +
    "cannot honour fails startup. Each app resolves the mode once (the API " +
    "in `apps/api/src/runtime-mode.ts`) and every local development " +
    "capability checks it. The `runtime-mode-keys` lint rule keeps the two " +
    "keys inside this owner.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
