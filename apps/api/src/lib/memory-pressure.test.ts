import { describe, expect, mock, test } from "bun:test";

import {
  createMemoryPressureGate,
  createMemoryPressureHandler,
} from "./memory-pressure";

describe("runtime memory pressure", () => {
  test.each(["warning", "critical"] as const)(
    "evicts every reconstructible cache on %s pressure",
    (level) => {
      const firstClear = mock(() => 3);
      const secondClear = mock(() => 5);
      const onEviction = mock(() => undefined);
      const handleMemoryPressure = createMemoryPressureHandler({
        caches: [{ clear: firstClear }, { clear: secondClear }],
        onEviction,
      });

      handleMemoryPressure(level);

      expect(firstClear).toHaveBeenCalledTimes(1);
      expect(secondClear).toHaveBeenCalledTimes(1);
      expect(onEviction).toHaveBeenCalledWith({
        evictedEntries: 8,
        level,
      });
    },
  );
});

describe("memory pressure gate", () => {
  const gate = ({ rss = 100 }: { rss?: number } = {}) => {
    let now = 1000;
    let rssBytes = rss;
    const instance = createMemoryPressureGate({
      holdMs: 60_000,
      now: () => now,
      readRssBytes: () => rssBytes,
      rssHighBytes: 1000,
    });
    return {
      advance: (ms: number) => {
        now += ms;
      },
      instance,
      setRss: (bytes: number) => {
        rssBytes = bytes;
      },
    };
  };

  test("is open with no signal and resident memory below the threshold", () => {
    expect(gate().instance.read()).toEqual({ cause: null, rssBytes: 100 });
  });

  test.each(["warning", "critical"] as const)(
    "a %s signal closes the gate for the hold window, then it reopens",
    (level) => {
      const { advance, instance } = gate();
      instance.record(level);

      expect(instance.read().cause).toBe("signal");
      advance(59_999);
      expect(instance.read().cause).toBe("signal");
      advance(1);
      expect(instance.read().cause).toBeNull();
    },
  );

  test("resident memory at the threshold closes the gate without any signal", () => {
    const { instance, setRss } = gate();
    setRss(1000);
    expect(instance.read()).toEqual({ cause: "rss", rssBytes: 1000 });
    setRss(999);
    expect(instance.read().cause).toBeNull();
  });

  test("admission includes the incoming job bytes", () => {
    const { instance } = gate({ rss: 900 });

    expect(instance.read(99).cause).toBeNull();
    expect(instance.read(100)).toEqual({ cause: "rss", rssBytes: 900 });
  });
});
