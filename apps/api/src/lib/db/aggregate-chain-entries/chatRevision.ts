import type { AggregateName } from "../aggregate-lock";

export default [
  "chatThread",
  "chatMessage",
] as const satisfies readonly AggregateName[];
