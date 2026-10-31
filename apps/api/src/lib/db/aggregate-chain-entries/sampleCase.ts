import type { AggregateName } from "../aggregate-lock";

export default [
  "workspace",
  "sampleCase",
] as const satisfies readonly AggregateName[];
