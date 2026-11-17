import { panic, Result } from "better-result";

/** How one attempt ended. */
type AttemptEnd<T> = { index: number } & (
  | { type: "answered"; answer: T }
  | { type: "lost"; error: unknown }
  | { type: "ended"; error: unknown }
);

/** Why no attempt answered: every answer was lost, or one attempt ended it. */
export type HedgedAttemptsFailure = {
  type: "lost" | "ended";
  /** The last loss, or the rejection that ended the operation. */
  error: unknown;
};

type HedgedAttemptsOptions<T> = {
  /** One attempt: resolves with the answer that arrived, rejects when none did. */
  attempt: () => Promise<T>;
  /**
   * Whether a rejection lost the answer (a connection error, a timeout),
   * which is retried, rather than ending the operation (the caller aborted).
   */
  isLost: (error: unknown) => boolean;
  /** How many attempts may follow the first. */
  maxRetries: number;
  /** How long an attempt may go unanswered before the next one starts. */
  hedgeAfterMs: number;
  /** Takes an answer that arrived after another attempt's was used. */
  onLateAnswer?: ((late: T) => void) | undefined;
  /** Resolves after `ms`, or once `signal` is aborted. */
  wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
};

const waitUnlessAborted = async (ms: number, signal: AbortSignal) => {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
};

/**
 * Run `attempt` until one answers, for an operation that is safe to send
 * again (the far side tells a repeat from a first attempt).
 *
 * An attempt whose answer is lost is followed by the next one at once; one
 * still unanswered after `hedgeAfterMs` is followed by the next one too, but
 * left running, since the far side may be working on it. At most
 * `maxRetries` attempts follow the first. The first answer that arrives,
 * from any attempt, is the operation's; later ones go to `onLateAnswer`. A
 * rejection that is not a lost answer ends the operation with it; when every
 * attempt lost its answer, the operation fails with the last loss.
 */
export const hedgedAttempts = async <T>({
  attempt,
  hedgeAfterMs,
  isLost,
  maxRetries,
  onLateAnswer,
  wait = waitUnlessAborted,
}: HedgedAttemptsOptions<T>): Promise<Result<T, HedgedAttemptsFailure>> => {
  const pending = new Map<number, Promise<AttemptEnd<T>>>();
  /** Answers that arrived before the operation was decided, unused yet. */
  const arrived = new Map<number, T>();
  let decided = false;
  let started = 0;
  let lastLoss: unknown = undefined;
  const answered = (index: number, answer: T): AttemptEnd<T> => {
    if (decided) {
      onLateAnswer?.(answer);
    } else {
      arrived.set(index, answer);
    }
    return { index, type: "answered", answer };
  };
  /** The operation is decided: every other answer that arrived is late. */
  const decide = (used?: number) => {
    decided = true;
    for (const [index, answer] of arrived) {
      if (index !== used) {
        onLateAnswer?.(answer);
      }
    }
    arrived.clear();
  };
  const start = () => {
    const index = started;
    started += 1;
    pending.set(
      index,
      attempt().then(
        (answer) => answered(index, answer),
        (error: unknown): AttemptEnd<T> => ({
          index,
          type: isLost(error) ? "lost" : "ended",
          error,
        }),
      ),
    );
  };
  const mayRetry = () => started <= maxRetries;
  start();
  while (pending.size > 0) {
    const hedge = new AbortController();
    const unanswered = mayRetry()
      ? [
          wait(hedgeAfterMs, hedge.signal).then(
            () => ({ type: "unanswered" }) as const,
          ),
        ]
      : [];
    const next = await Promise.race([...pending.values(), ...unanswered]);
    hedge.abort();
    if (next.type === "unanswered") {
      start();
      continue;
    }
    pending.delete(next.index);
    switch (next.type) {
      case "answered":
        decide(next.index);
        return Result.ok(next.answer);
      case "ended":
        decide();
        return Result.err({ type: "ended", error: next.error });
      case "lost":
        lastLoss = next.error;
        if (mayRetry()) {
          start();
        }
        break;
      default:
        next satisfies never;
        return panic("Unhandled attempt end");
    }
  }
  decide();
  return Result.err({ type: "lost", error: lastLoss });
};
