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

test("rejects an allowlisted adapter hash change over unchanged stored bytes without a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "pl-courts::search": fingerprint("new", "same-input", 0) },
      { "pl-courts::search": fingerprint("old", "same-input", 0) },
    ),
  ).toEqual([
    "pl-courts::search: fixture fingerprint changed without a version bump",
  ]);
});

test("accepts an allowlisted adapter hash change over unchanged stored bytes with a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "pl-courts::search": fingerprint("new", "same-input", 1) },
      { "pl-courts::search": fingerprint("old", "same-input", 0) },
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
