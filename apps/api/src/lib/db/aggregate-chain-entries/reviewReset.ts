import type { AggregateName } from "../aggregate-lock";

export default [
  "organization",
  "reviewResetRegistration",
  "workspace",
  "entity",
] as const satisfies readonly AggregateName[];
