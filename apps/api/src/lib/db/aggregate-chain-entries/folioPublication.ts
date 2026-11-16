import type { AggregateName } from "../aggregate-lock";

export default [
  "workspace",
  "folioCollabRoom",
  "entity",
  "entityVersion",
  "field",
  "processingClaim",
] as const satisfies readonly AggregateName[];
