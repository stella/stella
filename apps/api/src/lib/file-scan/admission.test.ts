import { describe, expect, test } from "bun:test";

import { createFileScanAdmission } from "@/api/lib/file-scan/admission";

describe("file scan admission", () => {
  test("queues scans in arrival order within the process limit", async () => {
    const admission = createFileScanAdmission(1);
    const firstRelease = await admission.acquire(100);
    const second = admission.acquire(100);
    const third = admission.acquire(100);

    expect(firstRelease).not.toBeNull();
    expect(admission.active()).toBe(1);
    firstRelease?.();

    const secondRelease = await second;
    expect(secondRelease).not.toBeNull();
    expect(admission.active()).toBe(1);
    secondRelease?.();

    const thirdRelease = await third;
    expect(thirdRelease).not.toBeNull();
    thirdRelease?.();
    expect(admission.active()).toBe(0);
  });

  test("abandons a waiter after its bounded wait", async () => {
    const admission = createFileScanAdmission(1);
    const release = await admission.acquire(100);

    expect(await admission.acquire(0)).toBeNull();
    expect(admission.active()).toBe(1);
    release?.();
  });
});
