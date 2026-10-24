import { panic } from "better-result";

type AdmissionRelease = () => void;
type AdmissionWaiter = {
  grant: () => void;
};

/** FIFO admission for CPU-heavy file scans within one API process. */
export const createFileScanAdmission = (limit: number) => {
  if (!Number.isInteger(limit) || limit < 1) {
    panic("File scan admission limit must be a positive integer");
  }

  let active = 0;
  const waiters: AdmissionWaiter[] = [];

  const releaseOnce = (): AdmissionRelease => {
    let released = false;
    return () => {
      if (released) {
        panic("File scan admission was released twice");
      }
      released = true;
      active -= 1;
      const next = waiters.shift();
      if (next) {
        active += 1;
        next.grant();
      }
    };
  };

  const acquire = async (waitMs: number): Promise<AdmissionRelease | null> => {
    if (active < limit) {
      active += 1;
      return releaseOnce();
    }
    return await new Promise((resolve) => {
      let waiting = true;
      const waiter: AdmissionWaiter = {
        grant: () => {
          waiting = false;
          clearTimeout(timer);
          resolve(releaseOnce());
        },
      };
      const timer = setTimeout(() => {
        if (!waiting) {
          return;
        }
        waiting = false;
        const index = waiters.indexOf(waiter);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
        resolve(null);
      }, waitMs);
      waiters.push(waiter);
    });
  };

  return { acquire, active: () => active };
};
