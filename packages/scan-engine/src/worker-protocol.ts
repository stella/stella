import type { RasterizedScanPage, ScanOptions } from "./types";

type SerializedWasmResult = {
  status: string;
  reason: string;
  pixels: Uint8Array;
  width: number;
  height: number;
  skew_degrees: number;
  /** Content bounds in the returned output image. */
  content_box: Uint32Array;
  /** Detected page corners in the source image, clockwise from top-left. */
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
