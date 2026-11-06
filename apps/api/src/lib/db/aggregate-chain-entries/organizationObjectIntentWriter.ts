import type { AggregateName } from "../aggregate-lock";

export default [
  "organizationObjectIntent",
  "workspace",
] as const satisfies readonly AggregateName[];
