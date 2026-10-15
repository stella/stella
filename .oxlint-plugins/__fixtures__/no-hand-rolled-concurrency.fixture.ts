import { backoffDelay } from "@stll/concurrency/backoff-delay";
import { chunk } from "@stll/concurrency/chunk";
import { sleep } from "@stll/concurrency/sleep";

declare const Bun: { sleep: (milliseconds: number) => Promise<void> };

export const rawSleep = async (ms: number) =>
  await new Promise<void>((resolve) => {
    // oxlint-disable-next-line no-hand-rolled-concurrency/no-hand-rolled-concurrency -- fixture: promise resolver timer duplicates sleep
    setTimeout(resolve, ms);
  });

// expect-clean: no-hand-rolled-concurrency/no-hand-rolled-concurrency
export const ownedSleep = async () => await sleep(1);
// expect-clean: no-hand-rolled-concurrency/no-hand-rolled-concurrency
export const ownedBackoff = () => backoffDelay(2, { baseMs: 1000 });
// expect-clean: no-hand-rolled-concurrency/no-hand-rolled-concurrency
export const ownedChunks = () => chunk([1, 2, 3], 2);

// expect-clean: no-hand-rolled-concurrency/no-hand-rolled-concurrency
export const nativeSleep = async () => await Bun.sleep(1);
// expect-clean: no-hand-rolled-concurrency/no-hand-rolled-concurrency
export const textWindows = (text: string) => {
  const windows: string[] = [];
  for (let i = 0; i < text.length; i += 2) {
    windows.push(text.slice(i, i + 2));
  }
  return windows;
};
