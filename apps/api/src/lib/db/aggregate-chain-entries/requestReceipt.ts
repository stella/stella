import type { AggregateName } from "../aggregate-lock";

export default [
  "requestReceipt",
  "organization",
  "workspace",
  "entity",
] as const satisfies readonly AggregateName[];
