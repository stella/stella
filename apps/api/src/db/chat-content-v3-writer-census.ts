import type { ChatTanStackPart } from "@/api/handlers/chat/types";

import type { LegacyV1WriterPart } from "./chat-content-v3-writer-types";

type WriterKind<T> = T extends `tool-${string}`
  ? "tool-*"
  : T extends `data-${string}`
    ? "data-*"
    : T;
type LegacyV1WriterKind = WriterKind<LegacyV1WriterPart["type"]>;
type Disposition = "convert" | "refuse" | "drop";

// Conditional dispositions depend on the declared optional fields and values;
// unsupported fields refuse the whole message instead of being discarded.
export const LEGACY_V1_WRITER_CENSUS = {
  text: "convert",
  reasoning: "convert",
  "tool-*": "convert",
  "dynamic-tool": "convert",
  "source-url": "refuse",
  "source-document": "refuse",
  file: "convert",
  "data-*": "convert",
  "step-start": "drop",
} as const satisfies Record<LegacyV1WriterKind, Disposition>;

export const LEGACY_V2_WRITER_CENSUS = {
  activity: "convert",
  audio: "convert",
  document: "convert",
  image: "convert",
  "structured-output": "convert",
  subagent: "refuse",
  text: "convert",
  thinking: "convert",
  "tool-call": "convert",
  "tool-result": "convert",
  "ui-resource": "convert",
  video: "convert",
} as const satisfies Record<ChatTanStackPart["type"], Disposition>;

type UnionKeys<T> = T extends unknown ? keyof T : never;
type V1PartFor<K> = LegacyV1WriterPart extends infer P
  ? P extends { type: infer T }
    ? WriterKind<T> extends K
      ? P
      : never
    : never
  : never;
export type V1WriterFieldCensus = {
  [K in LegacyV1WriterKind]: Record<UnionKeys<V1PartFor<K>>, unknown>;
};
export type V2WriterFieldCensus = {
  [K in ChatTanStackPart["type"]]: Record<
    UnionKeys<Extract<ChatTanStackPart, { type: K }>>,
    unknown
  >;
};
