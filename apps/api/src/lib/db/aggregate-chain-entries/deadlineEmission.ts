import type { AggregateName } from "../aggregate-lock";

export default [
  "orgFeatureAdmission",
  "scoutCensus",
  "entity",
  "processingClaim",
] as const satisfies readonly AggregateName[];
