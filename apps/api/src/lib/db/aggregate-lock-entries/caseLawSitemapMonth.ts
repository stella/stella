import type { AggregateLockDefinition } from "../aggregate-lock-definition";

// One public sitemap month, held from refresh count to write.
export default {
  rank: 46,
  kind: "advisory",
} as const satisfies AggregateLockDefinition;

export type Identity = { country: string; year: string; month: string };
