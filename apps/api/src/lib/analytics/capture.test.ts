import {
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

const captured: { properties: Record<string, unknown> }[] = [];

const realClient = await import("@/api/lib/analytics/client");
void mock.module("@/api/lib/analytics/client", () => ({
  ...realClient,
  getAnalytics: () => ({
    capture: (params: { properties: Record<string, unknown> }) => {
      captured.push(params);
    },
    flush: async () => undefined,
  }),
}));

const { captureError, resetCaptureWindows } =
  await import("@/api/lib/analytics/capture");

/**
 * Both helpers construct their error on a single source line, so every
 * occurrence from one helper shares a `error.frame` and therefore a
 * suppression key — the shape of a loop that keeps failing at the same site.
 * The two helpers sit on different lines, so they are different defects.
 */
const captureFromSiteA = (context?: Record<string, string>): void => {
  captureError(new Error("boom"), context);
};

const captureFromSiteB = (): void => {
  captureError(new Error("boom"));
};

beforeEach(() => {
  captured.length = 0;
  resetCaptureWindows();
});

describe("captureError repeat suppression", () => {
  test("a loop failing at one site reports once, not once per iteration", () => {
    // The shape that motivates the throttle: a held ingestion cursor re-runs
    // every cycle and spends one ingested event per attempt for as long as it
    // stays held. Each iteration builds a fresh Error, as the real loop does.
    for (let i = 0; i < 50; i += 1) {
      captureFromSiteA();
    }

    expect(captured).toHaveLength(1);
  });

  test("varying correlation context does not defeat the throttle", () => {
    // The key excludes caller context on purpose. Each cycle of the case-law
    // pipeline reports the same defect under a fresh sourceId, so a
    // context-sensitive key would suppress nothing in the case that motivated
    // the throttle.
    for (let i = 0; i < 10; i += 1) {
      captureFromSiteA({ sourceId: `source-${i}`, step: "uploadSourceRaw" });
    }

    expect(captured).toHaveLength(1);
  });

  test("distinct defects are never collapsed into one another", () => {
    // Suppression must not hide an unrelated failure that happens to occur
    // while a noisy one is throttled.
    captureFromSiteA();
    captureFromSiteB();

    expect(captured).toHaveLength(2);
  });

  test("suppressed occurrences are counted onto the next reported event", () => {
    // Nothing is silently swallowed: the rate stays recoverable from the
    // dashboard even though the repeats themselves are not ingested.
    const openedAt = new Date("2026-08-05T12:00:00.000Z");
    setSystemTime(openedAt);

    // One call site for every occurrence, so the window is only reopened by
    // the clock moving past it, never by a different key.
    for (let i = 0; i < 9; i += 1) {
      if (i === 8) {
        setSystemTime(new Date(openedAt.getTime() + 61_000));
      }
      captureFromSiteA();
    }
    setSystemTime();

    expect(captured).toHaveLength(2);
    expect(captured.at(0)?.properties["suppressed_repeats"]).toBeUndefined();
    expect(captured.at(1)?.properties["suppressed_repeats"]).toBe("7");
  });
});

describe("captureError issue grouping", () => {
  // PostHog groups issues from `$exception_list`; with the message and stack
  // redacted, every event of one class would collapse into a single issue and
  // first-seen automations would never fire again for that class. The
  // explicit fingerprint must therefore separate distinct defects while
  // carrying no message content.
  test("distinct defects produce distinct grouping fingerprints", () => {
    captureFromSiteA();
    captureFromSiteB();

    const fingerprints = captured.map(
      (event) => event.properties["$exception_fingerprint"],
    );
    expect(typeof fingerprints.at(0)).toBe("string");
    expect(fingerprints.at(0)).not.toBe(fingerprints.at(1));
  });

  test("the grouping fingerprint never carries the error message", () => {
    captureError(new Error("Privileged client matter detail"));

    const fingerprint = captured.at(0)?.properties["$exception_fingerprint"];
    expect(typeof fingerprint).toBe("string");
    expect(fingerprint).not.toContain("Privileged");
  });
});
