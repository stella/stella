import { expect, test } from "bun:test";

import {
  ADAPTER_PARK_ATTEMPT_INTERVAL_MS,
  ADAPTER_PARK_MIN_CYCLES,
  ADAPTER_PARK_MIN_DURATION_MS,
  type AdapterFailureRun,
  adapterParkOf,
} from "@/api/handlers/case-law/ingestion/adapter-park";

const NOW = 1_800_000_000_000;

const run = (
  overrides: Partial<AdapterFailureRun> = {},
): AdapterFailureRun => ({
  errorMessage:
    "Page fetch failed: Invalid type: Expected Array but received null",
  cycles: ADAPTER_PARK_MIN_CYCLES,
  startedAtMs: NOW - ADAPTER_PARK_MIN_DURATION_MS,
  lastAtMs: NOW,
  ...overrides,
});

test("the same failure for many cycles and hours parks until the next daily attempt", () => {
  expect(adapterParkOf(run(), NOW)).toEqual({
    errorMessage: run().errorMessage,
    cycles: ADAPTER_PARK_MIN_CYCLES,
    failingSinceMs: NOW - ADAPTER_PARK_MIN_DURATION_MS,
    untilMs: NOW + ADAPTER_PARK_ATTEMPT_INTERVAL_MS,
  });
});

test("a source with no failure run keeps its normal cadence", () => {
  expect(adapterParkOf(null, NOW)).toBeNull();
});

test("a short outage never parks a source, however many cycles it fails", () => {
  expect(
    adapterParkOf(
      run({
        cycles: 500,
        startedAtMs: NOW - ADAPTER_PARK_MIN_DURATION_MS + 1,
      }),
      NOW,
    ),
  ).toBeNull();
});

test("a few failures spread over a long time do not park a source", () => {
  expect(
    adapterParkOf(
      run({
        cycles: ADAPTER_PARK_MIN_CYCLES - 1,
        startedAtMs: NOW - 10 * ADAPTER_PARK_MIN_DURATION_MS,
      }),
      NOW,
    ),
  ).toBeNull();
});

test("once a day has passed the adapter may ask again", () => {
  expect(
    adapterParkOf(run(), NOW + ADAPTER_PARK_ATTEMPT_INTERVAL_MS - 1),
  ).not.toBeNull();
  expect(
    adapterParkOf(run(), NOW + ADAPTER_PARK_ATTEMPT_INTERVAL_MS),
  ).toBeNull();
});
