import type { AggregateName } from "../aggregate-lock";

export default [
  "orgFeatureAdmission",
  "workspace",
  "run",
  "currentStep",
  "obligation",
  "entity",
] as const satisfies readonly AggregateName[];
