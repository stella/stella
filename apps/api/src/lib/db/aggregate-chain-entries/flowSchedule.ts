import type { AggregateName } from "../aggregate-lock";

export default [
  "definitionCap",
  "schedulerClaim",
  "definition",
] as const satisfies readonly AggregateName[];
