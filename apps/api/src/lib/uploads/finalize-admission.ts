import { LIMITS } from "@/api/lib/limits";

type Waiter = { bytes: number; grant: () => void };

export type ByteAdmission = {
  /**
   * Admit work that will hold `bytes` in memory, waiting up to `waitMs` in
   * arrival order. Resolves to the release to call when the work is done, or
   * `null` when the budget stayed full for the whole wait.
   */
  acquire: (bytes: number, waitMs: number) => Promise<(() => void) | null>;
  inUseBytes: () => number;
};

/**
 * A process-wide budget for work whose memory scales with a file's size.
 *
 * Work is admitted while the bytes already in flight plus its own fit the
 * capacity. A single piece larger than the capacity is still admitted when
 * nothing else runs, so no file the limits accept can wait forever. Waiters
 * are served first come, first served: a large file is not starved by a
 * stream of small ones slipping past it.
 */
export const createByteAdmission = (capacityBytes: number): ByteAdmission => {
  let inUse = 0;
  const waiters: Waiter[] = [];

  const fits = (bytes: number) => inUse === 0 || inUse + bytes <= capacityBytes;

  const drain = () => {
    for (let next = waiters.at(0); next !== undefined; next = waiters.at(0)) {
      if (!fits(next.bytes)) {
        return;
      }
      waiters.shift();
      inUse += next.bytes;
      next.grant();
    }
  };

  const releaseOnce = (bytes: number) => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      inUse -= bytes;
      drain();
    };
  };

  const acquire = async (
    bytes: number,
    waitMs: number,
  ): Promise<(() => void) | null> => {
    if (waiters.length === 0 && fits(bytes)) {
      inUse += bytes;
      return releaseOnce(bytes);
    }
    return await new Promise((resolve) => {
      const waiter: Waiter = {
        bytes,
        grant: () => {
          clearTimeout(timer);
          resolve(releaseOnce(bytes));
        },
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index === -1) {
          return;
        }
        waiters.splice(index, 1);
        resolve(null);
        // The head of the queue leaving can let the next one in.
        drain();
      }, waitMs);
      waiters.push(waiter);
    });
  };

  return { acquire, inUseBytes: () => inUse };
};

/**
 * Upload finalization reads the whole staged file and scans and rewrites it,
 * holding several copies at once. Without a bound, a burst of large uploads
 * multiplies that by however many arrive together.
 */
export const UPLOAD_FINALIZE_ADMISSION = createByteAdmission(
  LIMITS.uploadFinalizeInFlightBytes,
);
