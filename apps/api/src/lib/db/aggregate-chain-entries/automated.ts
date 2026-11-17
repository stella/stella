import type { AggregateName } from "../aggregate-lock";

export default [
  "orgFeatureAdmission",
  "definitionCap",
  "schedulerClaim",
  "definition",
] as const satisfies readonly AggregateName[];
