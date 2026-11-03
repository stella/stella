import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "transcript",
  capability: "Transcript timing, vocabulary and text exports",
  owner: ["packages/transcript/"],
  summary:
    "Pure transcript schemas, timeline transforms, chunk planning, vocabulary budgeting and string exports.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
