import type { TypstOutputFormat } from "./compiler";

export type TypstWorkerRequest = {
  id: number;
  template: string;
  inputs: Record<string, string>;
  format: TypstOutputFormat;
  maxOutputBytes: number;
};

export type TypstWorkerReply =
  | { type: "ready" }
  | {
      type: "rendered";
      id: number;
      bytes: Uint8Array;
      compileMs: number;
      memoryBytes: number;
      /** Highest process RSS the watchdog sampled so far. */
      peakRssBytes: number;
    }
  | {
      type: "failed";
      id: number;
      reason: "diagnostics" | "output-too-large" | "crashed";
      diagnostics: string[];
      memoryBytes: number;
      peakRssBytes: number;
    };

/** Signal the in-process watchdog raises when the memory cap is exceeded. */
export const TYPST_MEMORY_SIGNAL = "SIGUSR2";
