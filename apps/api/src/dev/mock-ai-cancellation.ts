import { panic } from "better-result";

// Main forwards request.signal; the SDK upgrade forwards abortSignal.
// Keep this compatibility boundary until the older SDK is no longer supported.
type MockAiCancellationOptions = {
  request?: Request | RequestInit;
  abortSignal?: AbortSignal;
};

export const mockAiCancellationSignal = (options: MockAiCancellationOptions) =>
  options.abortSignal ?? options.request?.signal ?? undefined;

export const MOCK_AI_CANCELLATION_MARKER = "Stream until stopped please";

// Cancellation specs need a live turn, regardless of how long reload takes.
// The provider's run signal owns this wait; detaching a viewer cannot end it.
export async function* mockAiCancellationChunks(
  signal: AbortSignal | undefined,
) {
  if (signal === undefined) {
    return panic("The cancellation fixture requires the provider run signal");
  }
  signal.throwIfAborted();
  yield "This mock reply streams back";
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  signal.throwIfAborted();
}
