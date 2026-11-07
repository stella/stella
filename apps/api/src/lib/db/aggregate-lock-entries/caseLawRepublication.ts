import type { AggregateLockDefinition } from "../aggregate-lock-definition";

// Global fence for linking republished rulings and discovering their aliases.
// Link pages use exclusive mode; erasures use shared mode.
export default {
  rank: 45,
  kind: "advisory",
} as const satisfies AggregateLockDefinition;

export type Identity = "global";
