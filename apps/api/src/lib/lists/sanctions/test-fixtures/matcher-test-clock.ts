export const createMatcherTestClock = () => {
  let instant = 0;
  const timers = new Set<{ expiresAt: number; expire: () => void }>();
  return {
    now: () => instant,
    schedule: (expire: () => void, durationMs: number) => {
      const timer = { expiresAt: instant + durationMs, expire };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    elapse: (durationMs: number) => {
      instant += durationMs;
    },
    advance: (durationMs: number) => {
      instant += durationMs;
      for (const timer of timers) {
        if (timer.expiresAt > instant) {
          continue;
        }
        timers.delete(timer);
        timer.expire();
      }
    },
    pending: () => [...timers].map(({ expiresAt }) => expiresAt - instant),
  };
};
