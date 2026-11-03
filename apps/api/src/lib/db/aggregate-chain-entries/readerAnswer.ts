import type { AggregateName } from "../aggregate-lock";

export default [
  "readerAnswer",
  "readerAnswerMessage",
] as const satisfies readonly AggregateName[];
