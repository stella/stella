import type { AggregateName } from "../aggregate-lock";

export default [
  "sharepointPolicy",
  "sharepointConnection",
] as const satisfies readonly AggregateName[];
