import type { AggregateName } from "../aggregate-lock";

export default [
  "desktopBatch",
  "workspace",
] as const satisfies readonly AggregateName[];
