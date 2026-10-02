import { expect, spyOn, test } from "bun:test";

import { remainingCycleMs } from "@/api/lib/legal-search/cycle-deadline";

import {
  createSourceStoredTotalAdmission,
  SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS,
} from "./source-total-admission";

test("one cycle admits at most one long-read unit even when three units fit its budget", async () => {
  const clock = spyOn(performance, "now").mockReturnValue(0);
  try {
    const deadline = {
      expiresAt: 3 * SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS,
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
    expect(remainingCycleMs(deadline)).toBe(
      2 * SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS,
    );
    expect(await admit({ deadline })).toBe("held");
    expect(await admit({ deadline })).toBe("held");
    expect(remainingCycleMs(deadline)).toBe(
      2 * SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS,
    );
    expect(reads).toBe(1);
  } finally {
    clock.mockRestore();
  }
});

for (const kind of ["stop", "unknown", "degraded"] as const) {
  test(`fresh ${kind} load verdict controls count admission`, async () => {
    const clock = spyOn(performance, "now").mockReturnValue(0);
    try {
      const deadline = {
        expiresAt: SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS + 5000,
        signal: new AbortController().signal,
      };
      const admit = createSourceStoredTotalAdmission({
        readVerdict: async () => ({ kind, signals: [] }),
      });
      const expectedAdmission = {
        stop: "held",
        unknown: "unknown",
        degraded: "granted",
      } as const;
      expect(await admit({ deadline })).toBe(expectedAdmission[kind]);
      expect(remainingCycleMs(deadline)).toBe(
        kind === "degraded"
          ? 5000
          : SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS + 5000,
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
      {
        expiresAt: SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS - 1,
        signal: new AbortController().signal,
      },
      {
        expiresAt: SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS + 5000,
        signal: aborted.signal,
      },
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
      const deadline = {
        expiresAt: SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS + 5000,
        signal: controller.signal,
      };
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
        condition === "abort"
          ? SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS + 5000
          : SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS - 1000,
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
      expiresAt: 3 * SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS,
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
    expect(remainingCycleMs(deadline)).toBe(
      2 * SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS,
    );
  } finally {
    clock.mockRestore();
  }
});

test("a long-read admission reserves 130 seconds rather than a planner-sized charge", async () => {
  const clock = spyOn(performance, "now").mockReturnValue(0);
  try {
    const deadline = {
      expiresAt: 200_000,
      signal: new AbortController().signal,
    };
    const admit = createSourceStoredTotalAdmission({
      readVerdict: async () => ({ kind: "normal", signals: [] }),
    });
    expect(await admit({ deadline })).toBe("granted");
    expect(remainingCycleMs(deadline)).toBe(70_000);
  } finally {
    clock.mockRestore();
  }
});
