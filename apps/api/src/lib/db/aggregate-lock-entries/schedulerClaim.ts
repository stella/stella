import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 20,
  kind: "row",
  holder: "application",
} as const satisfies AggregateLockDefinition;

export type Identity = { id: string };
