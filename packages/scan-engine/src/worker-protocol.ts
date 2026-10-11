import type {
  RasterizedScanPage,
  ScanOptions,
  ScanCornerSuggestion,
} from "./types";

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

type WorkerPage = Omit<RasterizedScanPage, "pixels">;

export type WorkerRequest =
  | {
      type: "clean";
      page: WorkerPage;
      pixels: ArrayBuffer;
      options: ScanOptions;
    }
  | {
      type: "detect";
      page: WorkerPage;
      pixels: ArrayBuffer;
    };

export type WorkerResponse =
  | { type: "result"; result: SerializedWasmResult }
  | { type: "detected"; suggestion: ScanCornerSuggestion }
  | {
      type: "error";
      errorType: "runtime-trap" | "failure";
      message: string;
    };
