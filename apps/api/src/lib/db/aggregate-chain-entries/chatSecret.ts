import type { AggregateName } from "../aggregate-lock";

export default [
  "chatThread",
  "chatTurn",
  "chatSecret",
] as const satisfies readonly AggregateName[];
