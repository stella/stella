import type { AggregateName } from "../aggregate-lock";

export default [
  "orgFeatureAdmission",
  "schedulerClaim",
  "definitionCap",
  "definition",
  "uploadReceipt",
] as const satisfies readonly AggregateName[];
