import type { AggregateName } from "../aggregate-lock";

export default [
  "workspace",
  "entity",
  "entityVersion",
  "field",
  "processingClaim",
] as const satisfies readonly AggregateName[];
