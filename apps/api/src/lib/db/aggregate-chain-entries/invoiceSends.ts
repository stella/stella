import type { AggregateName } from "../aggregate-lock";

export default [
  "invoiceSendCapacity",
  "workspace",
] as const satisfies readonly AggregateName[];
