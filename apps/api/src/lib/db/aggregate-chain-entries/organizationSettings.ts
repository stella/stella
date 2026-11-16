import type { AggregateName } from "../aggregate-lock";

export default [
  "organization",
  "organizationSettings",
] as const satisfies readonly AggregateName[];
