import { TaggedError } from "better-result";

export type PDFViewerCode =
  | "LOAD_FAILED"
  | "NO_RENDERABLE_PAGES"
  | "PASSWORD_REQUIRED"
  | "INCORRECT_PASSWORD"
  | "CANCELLED";

export class PDFViewerError extends TaggedError("PDFViewerError")<{
  code: PDFViewerCode;
  message: string;
  cause?: unknown;
}>() {}
