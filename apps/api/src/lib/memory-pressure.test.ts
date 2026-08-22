import { describe, expect, mock, test } from "bun:test";

import { createMemoryPressureHandler } from "./memory-pressure";

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
