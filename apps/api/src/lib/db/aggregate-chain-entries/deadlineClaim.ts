import type { AggregateName } from "../aggregate-lock";

export default [
  "orgFeatureAdmission",
  "processingClaim",
] as const satisfies readonly AggregateName[];
