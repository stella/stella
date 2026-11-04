import type { AggregateName } from "../aggregate-lock";

export default [
  "workspace",
  "memberCleanup",
  "run",
  "currentStep",
  "obligation",
  "entity",
] as const satisfies readonly AggregateName[];
