import type { AggregateName } from "../aggregate-lock";

export default [
  "orgFeatureAdmission",
  "entity",
  "processingClaim",
] as const satisfies readonly AggregateName[];
