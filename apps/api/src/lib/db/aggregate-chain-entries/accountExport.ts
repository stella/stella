import type { AggregateName } from "../aggregate-lock";

export default [
  "account",
  "accountExport",
] as const satisfies readonly AggregateName[];
