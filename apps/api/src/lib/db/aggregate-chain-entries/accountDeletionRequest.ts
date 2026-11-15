import type { AggregateName } from "../aggregate-lock";

export default [
  "account",
  "accountDeletionRequest",
] as const satisfies readonly AggregateName[];
