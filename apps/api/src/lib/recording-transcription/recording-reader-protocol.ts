import type { RecordingPiece, RecordingRefusal } from "@stll/recording-wasm";

export type RecordingReaderMessage =
  | { type: "open"; bytes: ArrayBuffer; extension: string | null }
  | { type: "next" };

export type RecordingReaderReply =
  | { type: "opened"; durationMs: number | null }
  | { type: "piece"; piece: RecordingPiece }
  | { type: "end" }
  | { type: "refused"; refusal: RecordingRefusal };
