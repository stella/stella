import { expect, test } from "bun:test";

import {
  failureAsEmptyDifference,
  seededReason,
} from "./failure-as-empty-baseline.ts";

const SITE = "apps/api/src/lib/example.ts::read::catch-returns-empty#1";
const NEW_SITE = "apps/api/src/lib/example.ts::read::catch-returns-empty#2";

test("failure-as-empty entries must match the observed set in both directions", () => {
  expect(
    failureAsEmptyDifference({
      observed: [SITE],
      recorded: [SITE],
      committed: null,
    }),
  ).toEqual({ added: [], stale: [], duplicates: [], grown: [] });
  expect(
    failureAsEmptyDifference({
      observed: [SITE, NEW_SITE],
      recorded: [SITE],
      committed: null,
    }).added,
  ).toEqual([NEW_SITE]);
  expect(
    failureAsEmptyDifference({
      observed: [],
      recorded: [SITE],
      committed: null,
    }).stale,
  ).toEqual([SITE]);
});

test("a key added to the committed baseline fails even when the observed set matches", () => {
  expect(
    failureAsEmptyDifference({
      observed: [SITE, NEW_SITE],
      recorded: [SITE, NEW_SITE],
      committed: [SITE],
    }).grown,
  ).toEqual([NEW_SITE]);
});

test("two sites cannot collapse into one key", () => {
  expect(
    failureAsEmptyDifference({
      observed: [SITE, SITE],
      recorded: [SITE],
      committed: null,
    }).duplicates,
  ).toEqual([SITE]);
});

test("seeded reasons route publisher reads to the adapter owner", () => {
  expect(
    seededReason(
      "apps/api/src/handlers/case-law/ingestion/adapters/sk-us.ts::fetchJson::result-catch-empty#1",
    ),
  ).toContain("readPublisher");
  expect(seededReason(SITE)).toContain("ReadOutcome");
});
