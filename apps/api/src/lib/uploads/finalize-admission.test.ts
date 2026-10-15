import { describe, expect, test } from "bun:test";

import { createByteAdmission } from "./finalize-admission";

describe("byte admission", () => {
  test("admits work while it fits and holds the rest until bytes are released", async () => {
    const admission = createByteAdmission(100);
    const first = await admission.acquire(60, 1000);
    expect(first).not.toBeNull();
    expect(admission.inUseBytes()).toBe(60);

    let secondAdmitted = false;
    const second = admission.acquire(60, 1000).then((release) => {
      secondAdmitted = true;
      return release;
    });
    await Bun.sleep(5);
    expect(secondAdmitted).toBeFalse();

    first?.();
    const secondRelease = await second;
    expect(secondRelease).not.toBeNull();
    expect(admission.inUseBytes()).toBe(60);
    secondRelease?.();
    expect(admission.inUseBytes()).toBe(0);
  });

  test("admits a single piece larger than the capacity when nothing else runs", async () => {
    const admission = createByteAdmission(100);
    const release = await admission.acquire(500, 1000);
    expect(release).not.toBeNull();
    expect(admission.inUseBytes()).toBe(500);
    release?.();
  });

  test("serves waiters in arrival order, so small work cannot starve a large file", async () => {
    const admission = createByteAdmission(100);
    const running = await admission.acquire(50, 1000);
    const order: string[] = [];
    const large = admission.acquire(100, 1000).then((release) => {
      order.push("large");
      return release;
    });
    const small = admission.acquire(10, 1000).then((release) => {
      order.push("small");
      return release;
    });
    await Bun.sleep(5);
    // The small one would fit beside the running work, but it queued behind
    // the large one.
    expect(order).toEqual([]);

    running?.();
    (await large)?.();
    (await small)?.();
    expect(order).toEqual(["large", "small"]);
  });

  test("gives up after the wait, and a released slot is not counted twice", async () => {
    const admission = createByteAdmission(100);
    const running = await admission.acquire(100, 1000);
    expect(await admission.acquire(10, 10)).toBeNull();

    running?.();
    running?.();
    expect(admission.inUseBytes()).toBe(0);
  });
});
