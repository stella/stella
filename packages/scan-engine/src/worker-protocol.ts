import type { RasterizedScanPage, ScanOptions } from "./types";

type SerializedWasmResult = {
  status: string;
  reason: string;
  pixels: Uint8Array;
  width: number;
  height: number;
  skew_degrees: number;
  content_box: Uint32Array;
  applied_quad: Float32Array;
};

export type WorkerRequest = {
  page: Omit<RasterizedScanPage, "pixels">;
  pixels: ArrayBuffer;
  options: ScanOptions;
};

export type WorkerResponse =
  | { type: "result"; result: SerializedWasmResult }
  | {
      type: "error";
      errorType: "runtime-trap" | "failure";
      message: string;
    };
