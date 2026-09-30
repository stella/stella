import { useSyncExternalStore } from "react";

import { Temporal } from "@stll/time";

const CLOCK_TICK_MS = 1000;
const subscribers = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | undefined;
let snapshot = 0;

const readTime = () => Temporal.Now.instant().epochMilliseconds;
const tick = () => {
  snapshot = readTime();
  for (const subscriber of subscribers) {
    subscriber();
  }
};

const subscribe = (subscriber: () => void) => {
  subscribers.add(subscriber);
  if (interval === undefined) {
    tick();
    interval = setInterval(tick, CLOCK_TICK_MS);
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      clearInterval(interval);
      interval = undefined;
    }
  };
};

export const useSharedClock = () =>
  useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => 0,
  );
