import { TaggedError } from "better-result";

export type OutlookErrorCode = "attachment-read-unavailable";

export class OutlookError extends TaggedError("OutlookError")<{
  cause?: unknown;
  code?: OutlookErrorCode;
  message: string;
}> {}

export const isAttachmentReadError = (
  error: unknown,
): error is OutlookError & { code: "attachment-read-unavailable" } =>
  error instanceof OutlookError && error.code === "attachment-read-unavailable";
