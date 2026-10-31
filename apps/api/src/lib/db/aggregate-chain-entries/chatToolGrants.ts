import type { AggregateName } from "../aggregate-lock";

export default [
  "chatThread",
  "chatToolGrants",
] as const satisfies readonly AggregateName[];
