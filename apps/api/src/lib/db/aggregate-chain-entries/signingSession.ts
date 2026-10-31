import type { AggregateName } from "../aggregate-lock";

export default [
  "workspace",
  "signingSession",
] as const satisfies readonly AggregateName[];
