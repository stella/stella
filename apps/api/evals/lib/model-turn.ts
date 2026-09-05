/**
 * Shared model-turn loop for the evals under `apps/api/evals/`: owns the
 * abort timer, drains a `chat()` stream, and reports a rejected stream as an
 * error turn instead of an uncaught rejection. Every eval's loop differed
 * only in which chunks it accumulated (final text, tool-call arguments, tool
 * names, ...), so this helper takes over everything else and hands each
 * chunk to the caller unchanged.
 */
import type { TokenUsage } from "@tanstack/ai";
import { EventType } from "@tanstack/ai";

import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { tokenUsageFromRunFinishedChunk } from "@/api/lib/tanstack-ai-usage";

export type EvalModelTurnResult = {
  /** The provider's run error, or the stream/`chat()` rejection message. */
  error: string | null;
  latencyMs: number;
  usage: TokenUsage | null;
};

export type RunEvalModelTurnOptions = {
  /**
   * Starts the model call. Receives the `AbortController` this helper owns
   * so the caller can pass it straight into `chat()`.
   */
  chat: (abortController: AbortController) => AsyncIterable<PublicStreamChunk>;
  /** Aborts the run, and unblocks a hung stream, after this many ms. */
  timeoutMs: number;
  /**
   * Invoked for every chunk the stream yields, in order, so the caller can
   * accumulate whatever it scores on (text, tool-call arguments, ...).
   */
  onChunk: (chunk: PublicStreamChunk) => void;
  /** Injectable for tests; defaults to the global timer functions. */
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
};

/**
 * Runs one model turn: creates the abort timer, iterates the stream, and
 * always clears the timer, even when `chat()` or the stream it returns
 * rejects mid-turn (adapter error, dropped connection). Callers combine the
 * returned `error`/`usage`/`latencyMs` with whatever `onChunk` accumulated.
 */
export const runEvalModelTurn = async ({
  chat,
  timeoutMs,
  onChunk,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: RunEvalModelTurnOptions): Promise<EvalModelTurnResult> => {
  const start = performance.now();
  const abortController = new AbortController();
  const abortTimer = setTimer(() => abortController.abort(), timeoutMs);
  let usage: TokenUsage | null = null;
  let error: string | null = null;
  try {
    const stream = chat(abortController);
    for await (const chunk of stream) {
      onChunk(chunk);
      if (chunk.type === EventType.RUN_ERROR) {
        error = chunk.message;
        continue;
      }
      if (chunk.type === EventType.RUN_FINISHED) {
        usage = tokenUsageFromRunFinishedChunk(chunk) ?? null;
      }
    }
  } catch (caughtError: unknown) {
    error =
      caughtError instanceof Error ? caughtError.message : String(caughtError);
  } finally {
    clearTimer(abortTimer);
  }
  return { error, latencyMs: Math.round(performance.now() - start), usage };
};
