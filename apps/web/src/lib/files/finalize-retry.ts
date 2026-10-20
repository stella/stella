import { advisedRetry } from "@stll/concurrency/retry-advised";
import { sleep } from "@stll/concurrency/sleep";

import type { FinalizeBusyEvent } from "@/lib/upload-queue";
import { getRetryAfterSeconds } from "@/lib/upload-queue";

type RetryRefusedFinalizeOptions<T> = {
  finalize: () => Promise<T>;
  refusalResponse: (result: T) => Response | null;
  signal?: AbortSignal | undefined;
  onBusy?: ((event: FinalizeBusyEvent | null) => void) | undefined;
  wait?: ((delayMs: number, signal?: AbortSignal) => Promise<void>) | undefined;
};

export const retryRefusedFinalize = async <T>({
  finalize,
  refusalResponse,
  signal,
  onBusy,
  wait = async (delayMs, waitSignal) =>
    await sleep(
      delayMs,
      waitSignal === undefined ? undefined : { signal: waitSignal },
    ),
}: RetryRefusedFinalizeOptions<T>): Promise<T> => {
  let result = await finalize();
  for (let attempt = 1; ; attempt += 1) {
    const response = refusalResponse(result);
    if (response === null) {
      break;
    }
    const decision = advisedRetry({
      attempt,
      advisedDelayMs: (getRetryAfterSeconds({ response }) ?? 0) * 1000,
    });
    if (decision.type === "give-up") {
      break;
    }
    onBusy?.({
      attempt,
      retryAfterS: Math.max(1, Math.ceil(decision.delayMs / 1000)),
    });
    await wait(decision.delayMs, signal);
    result = await finalize();
  }
  onBusy?.(null);
  return result;
};
