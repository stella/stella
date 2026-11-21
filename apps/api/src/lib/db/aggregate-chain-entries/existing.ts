import type { AggregateName } from "../aggregate-lock";

export default [
  "organization",
  "workspace",
  "run",
  "currentStep",
  "obligation",
  "entity",
] as const satisfies readonly AggregateName[];
