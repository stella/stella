import type { AggregateName } from "../aggregate-lock";

export default [
  "orgFeatureAdmission",
  "schedulerClaim",
  "definitionCap",
  "definition",
] as const satisfies readonly AggregateName[];
