type BackfillPassBatch<Value> = {
  done: boolean;
  sleepMs: number;
  value: Value;
};

type BackfillPassOptions<Value> = {
  step: () => Promise<BackfillPassBatch<Value>>;
  onBatch?: (batch: BackfillPassBatch<Value>) => void | Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
};

/** Schedule committed batches sequentially; a deferred or failed step ends this pass. */
export const runBackfillPass = async <Value>({
  step,
  onBatch,
  sleep,
}: BackfillPassOptions<Value>): Promise<void> => {
  while (true) {
    const batch = await step();
    await onBatch?.(batch);
    if (batch.done) {
      return;
    }
    if (batch.sleepMs > 0) {
      await sleep(batch.sleepMs);
    }
  }
};
