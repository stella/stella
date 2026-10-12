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
export const MOCK_AI_CONTINUOUS_MARKER = "Stream continuously please";
export const MOCK_AI_CANCELLATION_REPLY_TAIL =
  " while awaiting an explicit cancellation.";

const CONTINUOUS_STREAM_REPLY =
  "This mock reply streams back while the composer remains editable. ";
const CONTINUOUS_STREAM_CHUNK_DELAY_MS = 10;
// TEXT_MESSAGE_START + the prefix + these tail pieces fill one SDK batch.
const CANCELLATION_TAIL_CHUNK_COUNT = 30;

// Keep filling durable batches during browser actions. Only Stop ends the run;
// neither a reload nor slow typing can exhaust the fixture.
export async function* mockAiContinuousChunks(signal: AbortSignal | undefined) {
  if (signal === undefined) {
    panic("The continuous fixture requires the provider run signal");
  }
  while (true) {
    for (const delta of CONTINUOUS_STREAM_REPLY) {
      signal.throwIfAborted();
      yield delta;
      await Bun.sleep(CONTINUOUS_STREAM_CHUNK_DELAY_MS);
    }
  }
}

// Cancellation specs need a live turn, regardless of how long reload takes.
// The provider's run signal owns this wait; detaching a viewer cannot end it.
export async function* mockAiCancellationChunks(
  signal: AbortSignal | undefined,
) {
  if (signal === undefined) {
    panic("The cancellation fixture requires the provider run signal");
  }
  signal.throwIfAborted();
  yield "This mock reply streams back";
  // Flush the entire answer, leaving no buffered suffix parked until Stop.
  for (let index = 0; index < CANCELLATION_TAIL_CHUNK_COUNT; index += 1) {
    signal.throwIfAborted();
    yield MOCK_AI_CANCELLATION_REPLY_TAIL.slice(
      Math.floor(
        (index * MOCK_AI_CANCELLATION_REPLY_TAIL.length) /
          CANCELLATION_TAIL_CHUNK_COUNT,
      ),
      Math.floor(
        ((index + 1) * MOCK_AI_CANCELLATION_REPLY_TAIL.length) /
          CANCELLATION_TAIL_CHUNK_COUNT,
      ),
    );
  }
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  signal.throwIfAborted();
}
