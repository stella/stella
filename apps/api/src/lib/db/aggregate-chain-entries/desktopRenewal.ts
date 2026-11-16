import type { AggregateName } from "../aggregate-lock";

export default [
  "desktopMembership",
  "desktopCredential",
] as const satisfies readonly AggregateName[];
