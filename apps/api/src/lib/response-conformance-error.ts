import { panic, Result, TaggedError } from "better-result";

/** Path-only diagnostics: response values can contain privileged content. */
export class ResponseConformanceError extends TaggedError(
  "ResponseConformanceError",
)<{
  message: string;
  route: string;
  status: number | "success";
  issuePath: string;
  contentType?: string;
}> {}

/** A response schema violation is a programmer defect, never an expected error response. */
export const rethrowResponseConformanceError = (error: unknown): void => {
  const seen = new Set<object>();
  let current = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    if (ResponseConformanceError.is(current)) {
      panic(current.message, current);
    }
    seen.add(current);
    const candidate = current;
    const cause = Result.try(() =>
      "cause" in candidate ? candidate.cause : undefined,
    );
    if (Result.isError(cause)) {
      return;
    }
    current = cause.value;
  }
};
