import type { AggregateName } from "../aggregate-lock";

export default [
  "organizationObjectIntent",
  "organization",
] as const satisfies readonly AggregateName[];
