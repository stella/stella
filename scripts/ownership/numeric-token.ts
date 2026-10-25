import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "numeric-token",
  capability:
    "Whole-token decimal integers and decimals at machine string boundaries",
  owner: ["packages/agent-input/src/numeric-token.ts"],
  summary:
    "Protocol tokens use a whole ASCII decimal grammar, finite decimals and safe integers with explicit bounds. This is separate from agent-input's intentional locale-aware normalization of human-authored values. The raw-numeric-coercions ratchet counts older coercion sites and permits only shrinkage outside this owner.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
