import { describe, expect, test } from "bun:test";

import { mapConcurrent } from "@/lib/bounded-concurrency";

describe("bounded concurrent mapping", () => {
  test("never exceeds the configured concurrency and preserves input order", async () => {
    let active = 0;
    let peakActive = 0;
    const releases: (() => void)[] = [];
    const releaseActive = () => {
      for (const release of releases.splice(0)) {
        release();
      }
    };

    const mapped = mapConcurrent({
      concurrency: 2,
      items: [1, 2, 3, 4],
      map: async (item) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        active -= 1;
        return item * 10;
      },
    });

    await Promise.resolve();
    expect(active).toBe(2);
    releaseActive();
    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBe(2);
    releaseActive();

    expect(await mapped).toEqual([10, 20, 30, 40]);
    expect(peakActive).toBe(2);
  });

  test("rejects an invalid concurrency limit", async () => {
    await expect(
      mapConcurrent({ concurrency: 0, items: [1], map: async (item) => item }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
