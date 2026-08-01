import { Result } from "better-result";

/** Keep a failed recovery stamp inside the current work item's boundary. */
export const runMemoryExtractionFailureStamp = async (
  stampAttempt: () => Promise<void>,
): Promise<Result<void, unknown>> =>
  await Result.tryPromise({
    try: stampAttempt,
    catch: (error: unknown) => error,
  });
