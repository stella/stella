import { expect, spyOn, test } from "bun:test";

import { remainingCycleMs } from "@/api/lib/legal-search/cycle-deadline";

import { createSourceStoredTotalAdmission } from "./source-total-admission";

test("one cycle admits at most one planner unit even when three units fit its budget", async () => {
  const clock = spyOn(performance, "now").mockReturnValue(0);
  try {
    const deadline = {
      expiresAt: 30_000,
      signal: new AbortController().signal,
    };
    let reads = 0;
    const admit = createSourceStoredTotalAdmission({
      readVerdict: async () => {
        reads += 1;
        return { kind: "normal", signals: [] };
      },
    });
    expect(await admit({ deadline })).toBe("granted");
    expect(remainingCycleMs(deadline)).toBe(20_000);
    expect(await admit({ deadline })).toBe("held");
    expect(await admit({ deadline })).toBe("held");
    expect(remainingCycleMs(deadline)).toBe(20_000);
    expect(reads).toBe(1);
  } finally {
    clock.mockRestore();
  }
});

for (const kind of ["stop", "unknown", "degraded"] as const) {
  test(`fresh ${kind} load verdict controls planning admission`, async () => {
    const clock = spyOn(performance, "now").mockReturnValue(0);
    try {
      const deadline = {
        expiresAt: 15_000,
        signal: new AbortController().signal,
      };
      const admit = createSourceStoredTotalAdmission({
        readVerdict: async () => ({ kind, signals: [] }),
      });
      expect(await admit({ deadline })).toBe(
        kind === "degraded" ? "granted" : "held",
      );
      expect(remainingCycleMs(deadline)).toBe(
        kind === "degraded" ? 5000 : 15_000,
      );
    } finally {
      clock.mockRestore();
    }
  });
}

test("an absent, exhausted or aborted cycle cannot read load or admit housekeeping", async () => {
  const clock = spyOn(performance, "now").mockReturnValue(0);
  try {
    let reads = 0;
    const admit = createSourceStoredTotalAdmission({
      readVerdict: async () => {
        reads += 1;
        return { kind: "normal", signals: [] };
      },
    });
    const aborted = new AbortController();
    aborted.abort();
    for (const deadline of [
      undefined,
      { expiresAt: 9999, signal: new AbortController().signal },
      { expiresAt: 15_000, signal: aborted.signal },
    ]) {
      expect(await admit({ deadline })).toBe("held");
    }
    expect(reads).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

test.each(["abort", "elapsed"] as const)(
  "%s during the load read is rechecked before charging",
  async (condition) => {
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      const controller = new AbortController();
      const deadline = { expiresAt: 15_000, signal: controller.signal };
      const admit = createSourceStoredTotalAdmission({
        readVerdict: async () => {
          if (condition === "abort") {
            controller.abort();
          } else {
            now = 6000;
          }
          return { kind: "normal", signals: [] };
        },
      });
      expect(await admit({ deadline })).toBe("held");
      expect(remainingCycleMs(deadline)).toBe(
        condition === "abort" ? 15_000 : 9000,
      );
    } finally {
      clock.mockRestore();
    }
  },
);

test("concurrent admissions cannot reserve the same remaining operation budget", async () => {
  const clock = spyOn(performance, "now").mockReturnValue(0);
  try {
    const deadline = {
      expiresAt: 30_000,
      signal: new AbortController().signal,
    };
    const release = Promise.withResolvers<undefined>();
    let reads = 0;
    const admit = createSourceStoredTotalAdmission({
      readVerdict: async () => {
        reads += 1;
        await release.promise;
        return { kind: "normal", signals: [] };
      },
    });
    const first = admit({ deadline });
    const second = admit({ deadline });
    expect(reads).toBe(2);
    release.resolve(undefined);
    expect(await Promise.all([first, second])).toEqual(["granted", "held"]);
    expect(remainingCycleMs(deadline)).toBe(20_000);
  } finally {
    clock.mockRestore();
  }
});
