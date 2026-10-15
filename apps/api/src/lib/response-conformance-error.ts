import { TaggedError } from "better-result";

/** Path-only diagnostics: response values can contain privileged content. */
export class ResponseConformanceError extends TaggedError(
  "ResponseConformanceError",
)<{
  message: string;
  route: string;
  status: number | "success";
  issuePath: string;
}> {}

/** Result and panic wrappers must not turn a test conformance defect into an expected error response. */
export const rethrowResponseConformanceError = (error: unknown): void => {
  const seen = new Set<object>();
  let current = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    if (ResponseConformanceError.is(current)) {
      throw current;
    }
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
};
