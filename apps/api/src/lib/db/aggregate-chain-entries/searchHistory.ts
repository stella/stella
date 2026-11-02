import type { AggregateName } from "../aggregate-lock";

export default [
  "desktopMembership",
  "searchHistory",
] as const satisfies readonly AggregateName[];
