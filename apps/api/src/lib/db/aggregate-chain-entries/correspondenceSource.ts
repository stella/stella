import type { AggregateName } from "../aggregate-lock";

export default [
  "workspace",
  "entity",
  "correspondence",
] as const satisfies readonly AggregateName[];
