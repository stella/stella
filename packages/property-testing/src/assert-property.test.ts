import { afterEach, expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import {
  PropertyAssertionError,
  runProperty,
  assertProperty,
  failureFingerprint,
  propertyConfig,
} from "./index";

const ENV_KEYS = [
  "CI",
  "PROPERTY_TEST_SEED",
  "PROPERTY_TEST_PATH",
  "PROPERTY_TEST_NUM_RUNS_FACTOR",
  "PROPERTY_TEST_TIME_LIMIT_MS",
  "PROPERTY_TEST_REDACT",
];
const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
});
const neutralEnv = (): void => {
  for (const key of ENV_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
};
// Settles the run first, so assertions after it see the finished run.
const rejectionOf = async (run: Promise<void>): Promise<unknown> =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );
const FILE = "packages/property-testing/src/assert-property.test.ts";
const PIN = {
  seed: 123,
  path: "0",
  note: "Regression coverage",
  date: "2026-09-30",
};

test("identifies the calling test with an explicit id", () => {
  neutralEnv();
  expect(() =>
    assertProperty(
      "identifies the calling test with an explicit id",
      fc.property(fc.constant(1), () => false),
    ),
  ).toThrow(`"${FILE}::identifies the calling test with an explicit id"`);
});

test("replays pins before examples and generation for sync and async properties", async () => {
  neutralEnv();
  for (const asyncMode of [false, true]) {
    const values: number[] = [];
    const predicate = (value: number): boolean => {
      values.push(value);
      return true;
    };
    const property = asyncMode
      ? fc.asyncProperty(fc.constant(1), async (value) => predicate(value))
      : fc.property(fc.constant(1), predicate);
    await runProperty({
      file: FILE,
      id: "replay order",
      property,
      params: { numRuns: 2, examples: [[99]] },
      pinned: [PIN],
    });
    expect(values).toEqual([1, 1, 99, 1]);
  }
});

test("a failing pin stops generation and carries a reproducible report", () => {
  neutralEnv();
  let calls = 0;
  expect(() =>
    runProperty({
      file: FILE,
      id: "pinned failure",
      property: fc.property(fc.constant(1), () => {
        calls++;
        return false;
      }),
      params: { numRuns: 1, examples: [[99]] },
      pinned: [PIN],
    }),
  ).toThrow(
    /Replay: PROPERTY_TEST_SEED=123 PROPERTY_TEST_PATH='0' bun run --cwd/u,
  );
  expect(calls).toBe(1);
});

test("replay commands retain the owning runner and property preload", () => {
  neutralEnv();
  process.env["PROPERTY_TEST_NUM_RUNS_FACTOR"] = "10";
  for (const workspace of ["apps/api", "packages/conditions"]) {
    expect(() =>
      runProperty({
        file: `${workspace}/src/example.property.test.ts`,
        id: "replay [id]",
        property: fc.property(fc.constant(1), () => false),
        params: { numRuns: 1 },
        pinned: [PIN],
      }),
    ).toThrow(
      `Replay: PROPERTY_TEST_SEED=123 PROPERTY_TEST_PATH='0' PROPERTY_TEST_NUM_RUNS_FACTOR=10 bun run --cwd '${workspace}' test --preload @stll/property-testing/preload './src/example.property.test.ts' -t 'replay \\[id\\]'`,
    );
  }
});

test("honors an environment replay path only for its matching explicit seed", () => {
  neutralEnv();
  process.env["PROPERTY_TEST_SEED"] = "123";
  process.env["PROPERTY_TEST_PATH"] = "4:2";
  expect(propertyConfig({ seed: 123 }).path).toBe("4:2");
  expect(propertyConfig({ seed: 456, path: "0" }).path).toBe("0");
  expect(propertyConfig({ seed: 456 }).path).toBeUndefined();
  Reflect.deleteProperty(process.env, "PROPERTY_TEST_SEED");
  expect(propertyConfig({ seed: 123 }).path).toBeUndefined();
});

test("rejects a malformed replay path only when it would be replayed", () => {
  neutralEnv();
  process.env["PROPERTY_TEST_SEED"] = "123";
  for (const malformed of ["-1", "Infinity", "1:x", "1:", " 1", "1.5"]) {
    process.env["PROPERTY_TEST_PATH"] = malformed;
    expect(() => propertyConfig({ seed: 123 })).toThrow(
      "PROPERTY_TEST_PATH must be colon-separated non-negative integers",
    );
    expect(propertyConfig({ seed: 456 }).path).toBeUndefined();
  }
  process.env["PROPERTY_TEST_PATH"] = "0:12:3";
  expect(propertyConfig({ seed: 123 }).path).toBe("0:12:3");
});

test("time boxes only exploratory generation and leaves interruption non-failing", async () => {
  neutralEnv();
  process.env["PROPERTY_TEST_TIME_LIMIT_MS"] = "50";
  expect(propertyConfig().plugins).toBeUndefined();
  process.env["PROPERTY_TEST_NUM_RUNS_FACTOR"] = "10";
  const callerPlugin: fc.Plugin<[number]> = () => ({});
  const withCallerPlugin = propertyConfig({ plugins: [callerPlugin] }).plugins;
  expect(withCallerPlugin).toHaveLength(2);
  expect(withCallerPlugin?.[0]).toBe(callerPlugin);
  // 1000 runs of 20 ms would take 20 s; the 50 ms box stops them after a few
  // successes, and the interrupted run still passes.
  let calls = 0;
  await runProperty({
    file: FILE,
    id: "time boxed",
    property: fc.asyncProperty(fc.nat(), async () => {
      calls++;
      await Bun.sleep(20);
      return true;
    }),
    params: { numRuns: 100 },
    pinned: [],
  });
  expect(calls).toBeGreaterThan(0);
  expect(calls).toBeLessThan(100);
  process.env["PROPERTY_TEST_TIME_LIMIT_MS"] = "invalid";
  expect(() => propertyConfig()).toThrow(
    "PROPERTY_TEST_TIME_LIMIT_MS must be a positive integer",
  );
});

test("emits one CI marker per failure and omits redacted counterexamples", () => {
  neutralEnv();
  process.env["CI"] = "true";
  process.env["PROPERTY_TEST_NUM_RUNS_FACTOR"] = "1.1";
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const redacted of [false, true]) {
      if (redacted) {
        process.env["PROPERTY_TEST_REDACT"] = "1";
      }
      expect(() =>
        runProperty({
          file: FILE,
          id: "marker",
          property: fc.property(fc.constant("private"), () => false),
          params: { numRuns: 1 },
          pinned: [],
        }),
      ).toThrow(PropertyAssertionError);
      const line = log.mock.calls.at(-1)?.at(0);
      expect(typeof line).toBe("string");
      if (typeof line !== "string") {
        throw new TypeError("Expected marker line");
      }
      expect(line.startsWith("STELLA_PROPERTY_FAILURE ")).toBe(true);
      const record: unknown = JSON.parse(
        line.slice("STELLA_PROPERTY_FAILURE ".length),
      );
      expect(record).toMatchObject({
        file: FILE,
        id: "marker",
        factor: 1.1,
        fingerprint: expect.stringMatching(/^[a-f\d]{16}$/u),
        replay: expect.stringContaining("bun run --cwd"),
      });
      expect(line.includes('"counterexample"')).toBe(!redacted);
    }
    expect(log).toHaveBeenCalledTimes(2);
  } finally {
    log.mockRestore();
  }
});

test("fingerprints ignore generated values but distinguish assertion and id", () => {
  const variants = [
    'Expected "alpha" at 123',
    "Expected 'beta' at -456",
    "Expected `gamma` at 3.14",
    "Expected 01234567-89ab-cdef-0123-456789abcdef at 0xdeadbeef",
    "Expected abcdef1234567890 at 12",
  ];
  const fingerprints = variants.map((error) =>
    failureFingerprint({ id: "invariant", error }),
  );
  expect(new Set(fingerprints).size).toBe(1);
  expect(
    failureFingerprint({ id: "other", error: variants.at(0) ?? "" }),
  ).not.toBe(fingerprints.at(0));
  expect(
    failureFingerprint({ id: "invariant", error: "Different assertion" }),
  ).not.toBe(fingerprints.at(0));
  expect(
    failureFingerprint({ id: "invariant", error: "failure\nstack 123" }),
  ).toBe(failureFingerprint({ id: "invariant", error: "failure\nstack 456" }));
});

test("async failures reject with replay details before generated examples", async () => {
  neutralEnv();
  const values: number[] = [];
  const property = fc.asyncProperty(fc.constant(1), async (value) => {
    values.push(value);
    return false;
  });
  const failure = await rejectionOf(
    runProperty({
      file: FILE,
      id: "async replay",
      property,
      params: { numRuns: 1, examples: [[99]] },
      pinned: [PIN],
    }),
  );
  expect(failure).toBeInstanceOf(PropertyAssertionError);
  expect(String(failure)).toContain("Replay: PROPERTY_TEST_SEED=123");
  expect(values).toEqual([1]);
});

test("pins retain their own paths under a different environment replay", () => {
  neutralEnv();
  process.env["PROPERTY_TEST_SEED"] = "456";
  process.env["PROPERTY_TEST_PATH"] = "999";
  expect(() =>
    runProperty({
      file: FILE,
      id: "own pinned path",
      property: fc.property(fc.constant(1), () => false),
      params: { numRuns: 1 },
      pinned: [PIN],
    }),
  ).toThrow("PROPERTY_TEST_PATH='0'");
});

test("rejects custom reporters instead of allowing a failure to be swallowed", () => {
  neutralEnv();
  // Built untyped: the option is deprecated, and callers may still pass it.
  const legacy = { reporter: () => {} };
  expect(() =>
    assertProperty(
      "reporter boundary",
      fc.property(fc.constant(1), () => false),
      legacy,
    ),
  ).toThrow("custom reporters are unsupported");
});

test("nightly time limits cannot truncate pinned replays", async () => {
  neutralEnv();
  process.env["PROPERTY_TEST_NUM_RUNS_FACTOR"] = "10";
  process.env["PROPERTY_TEST_TIME_LIMIT_MS"] = "1";
  process.env["PROPERTY_TEST_SEED"] = "456";
  let calls = 0;
  const property = fc.asyncProperty(fc.constant(1), async () => {
    calls++;
    await Bun.sleep(2);
    return true;
  });
  // The generated run interrupts before its first result; the pin must finish first.
  const failure = await rejectionOf(
    runProperty({
      file: FILE,
      id: "untruncated pins",
      property,
      params: { numRuns: 1 },
      pinned: [PIN],
    }),
  );
  expect(failure).toBeInstanceOf(PropertyAssertionError);
  expect(String(failure)).toContain("Replay: PROPERTY_TEST_SEED=456");
  expect(calls).toBeGreaterThanOrEqual(10);
  expect(calls).toBeLessThan(12);
});
