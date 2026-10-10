import type { PublicCorpusClass } from "@/api/public-corpus-policy";

export type AdmissionClass = Exclude<PublicCorpusClass, "browse">;

/** Returns the slot; calling it again is a no-op. */
export type AdmissionLease = () => void;

type AdmissionRequest = {
  routeClass: AdmissionClass;
  /** Who is asking: requests from one client never hold two slots of a class. */
  client: string;
  /** How long to wait for a slot before refusing; 0 refuses at once. */
  waitMs: number;
  signal: AbortSignal;
};

type PublicCorpusAdmissionOptions = {
  capacityOf: (routeClass: AdmissionClass) => number;
  totalCapacity: number;
  /** Waiters beyond this are refused at once, so a burst cannot pile up. */
  maxWaiters: number;
};

type Waiter = {
  routeClass: AdmissionClass;
  client: string;
  admit: (lease: AdmissionLease) => void;
};

/**
 * Concurrency admission for public-corpus reads. A request takes a slot when
 * its class and the total have room and its client holds no slot of that
 * class; otherwise it waits in arrival order, up to its own deadline, and is
 * refused when the deadline passes, its request aborts or the queue is full.
 * The per-client rule is the fairness: one page or one crawler can hold one
 * slot per class, never all of them, while others wait.
 */
export const createPublicCorpusAdmission = ({
  capacityOf,
  totalCapacity,
  maxWaiters,
}: PublicCorpusAdmissionOptions) => {
  const classActive = new Map<AdmissionClass, number>();
  const clientActive = new Map<string, number>();
  const waiters: Waiter[] = [];
  let totalActive = 0;

  const clientKey = (routeClass: AdmissionClass, client: string) =>
    `${routeClass}\u0000${client}`;

  const hasRoom = (routeClass: AdmissionClass, client: string) =>
    (classActive.get(routeClass) ?? 0) < capacityOf(routeClass) &&
    totalActive < totalCapacity &&
    (clientActive.get(clientKey(routeClass, client)) ?? 0) === 0;

  const adjust = (routeClass: AdmissionClass, client: string, by: number) => {
    const key = clientKey(routeClass, client);
    classActive.set(routeClass, (classActive.get(routeClass) ?? 0) + by);
    clientActive.set(key, (clientActive.get(key) ?? 0) + by);
    if (clientActive.get(key) === 0) {
      clientActive.delete(key);
    }
    totalActive += by;
  };

  const grant = (
    routeClass: AdmissionClass,
    client: string,
  ): AdmissionLease => {
    adjust(routeClass, client, 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      adjust(routeClass, client, -1);
      admitWaiters();
    };
  };

  // Hoisted so a released lease can wake the queue it was granted from.
  function admitWaiters() {
    let index = 0;
    while (index < waiters.length) {
      const waiter = waiters[index];
      if (waiter !== undefined && hasRoom(waiter.routeClass, waiter.client)) {
        waiters.splice(index, 1);
        waiter.admit(grant(waiter.routeClass, waiter.client));
      } else {
        index += 1;
      }
    }
  }

  const acquire = async ({
    routeClass,
    client,
    waitMs,
    signal,
  }: AdmissionRequest): Promise<AdmissionLease | null> => {
    if (signal.aborted) {
      return null;
    }
    if (hasRoom(routeClass, client)) {
      return grant(routeClass, client);
    }
    if (waitMs <= 0 || waiters.length >= maxWaiters) {
      return null;
    }
    const { promise, resolve } = Promise.withResolvers<AdmissionLease | null>();
    const waiter: Waiter = { routeClass, client, admit: resolve };
    const refuse = () => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) {
        waiters.splice(index, 1);
      }
      resolve(null);
    };
    const timer = setTimeout(refuse, waitMs);
    signal.addEventListener("abort", refuse, { once: true });
    waiters.push(waiter);
    // Whichever way the wait ends, the other trigger must not fire later.
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", refuse);
    }
  };

  return { acquire };
};
