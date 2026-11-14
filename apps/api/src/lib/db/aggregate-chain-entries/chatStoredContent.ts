import type { AggregateName } from "../aggregate-lock";

export default [
  "chatOwnerStoredContentEgress",
  "chatStoredContentEgress",
  "chatThread",
  "chatTurn",
] as const satisfies readonly AggregateName[];
