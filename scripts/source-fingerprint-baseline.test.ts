import { expect, test } from "bun:test";

import { fingerprintEvolutionFailures } from "./source-fingerprint-baseline";

const fingerprint = (value: string, version: number) => ({
  fingerprint: value,
  version,
});

test("rejects a fixture fingerprint change without a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "cz-ns::decision": fingerprint("new", 0) },
      { "cz-ns::decision": fingerprint("old", 0) },
    ),
  ).toEqual([
    "cz-ns::decision: fixture fingerprint changed without a version bump",
  ]);
});

test("accepts a fixture fingerprint change with a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "cz-ns::decision": fingerprint("new", 1) },
      { "cz-ns::decision": fingerprint("old", 0) },
    ),
  ).toEqual([]);
});

test("rejects a fingerprint version decrease", () => {
  expect(
    fingerprintEvolutionFailures(
      { "cz-ns::decision": fingerprint("same", 0) },
      { "cz-ns::decision": fingerprint("same", 1) },
    ),
  ).toEqual(["cz-ns::decision: fingerprint version decreased"]);
});
