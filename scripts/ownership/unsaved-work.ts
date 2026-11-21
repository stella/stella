import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "unsaved-work",
  capability: "Guarding unsaved local work in the web app",
  owner: ["apps/web/src/hooks/use-unsaved-work.ts"],
  summary:
    "useUnsavedWork registers a named surface while it is dirty and installs the route blocker and unload prompt its guard asks for. " +
    "The stale-client refresh reads hasUnsavedWork() before reloading, so work guarded anywhere else would be reloaded over. " +
    "no-direct-unsaved-work-guard rejects TanStack blockers and beforeunload listeners outside the owner.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
