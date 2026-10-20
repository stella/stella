import { expect, test } from "bun:test";

import { fingerprintEvolutionFailures } from "./source-fingerprint-baseline";

const fingerprint = (
  value: string,
  storedInputIdentity: string,
  version: number,
) => ({
  fingerprint: value,
  storedInputIdentity,
  version,
});

test("accepts a fingerprint change over changed stored bytes without a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "cz-ns::decision": fingerprint("new", "new-input", 0) },
      { "cz-ns::decision": fingerprint("old", "old-input", 0) },
    ),
  ).toEqual([]);
});

test("rejects a fingerprint change over unchanged stored bytes without a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "cz-ns::decision": fingerprint("new", "same-input", 0) },
      { "cz-ns::decision": fingerprint("old", "same-input", 0) },
    ),
  ).toEqual([
    "cz-ns::decision: fixture fingerprint changed without a version bump",
  ]);
});

test("accepts a fingerprint change over unchanged stored bytes with a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "cz-ns::decision": fingerprint("new", "same-input", 1) },
      { "cz-ns::decision": fingerprint("old", "same-input", 0) },
    ),
  ).toEqual([]);
});

test("rejects a fingerprint version decrease", () => {
  expect(
    fingerprintEvolutionFailures(
      { "cz-ns::decision": fingerprint("same", "same-input", 0) },
      { "cz-ns::decision": fingerprint("same", "same-input", 1) },
    ),
  ).toEqual(["cz-ns::decision: fingerprint version decreased"]);
});
