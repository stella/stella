import { expect, test } from "bun:test";

import {
  buildLenientPlaceholderCollector,
  collectLenientPlaceholders,
} from "./lenient-placeholder-collector";

test("collects known literal placeholders with bracketed priority and ASCII boundaries", () => {
  const keys = [
    "[PERSON_1]",
    "PERSON_1-extra",
    "[PERSON_10]",
    "[A.B]",
    "Čapek",
    "👩‍⚖️",
    "x",
    "x+y",
  ];
  const collector = buildLenientPlaceholderCollector(
    new Map(keys.map((key) => [key, key])),
  );
  expect(collector).not.toBeNull();
  if (collector === null) {
    return;
  }
  const cases = [
    { text: "[PERSON_10] PERSON_1", expected: ["[PERSON_10]", "[PERSON_1]"] },
    { text: "PERSON_1-extra", expected: ["PERSON_1-extra"] },
    { text: "xPERSON_1 PERSON_1x _PERSON_1 PERSON_1_", expected: ["x"] },
    { text: "ČPERSON_1Č", expected: ["[PERSON_1]"] },
    {
      text: "[A.B] A.B [UNKNOWN_1] Čapek 👩‍⚖️",
      expected: ["[A.B]", "Čapek", "👩‍⚖️"],
    },
    {
      text: "x+y x [PERSON_1] [PERSON_1]",
      expected: ["x+y", "x", "[PERSON_1]"],
    },
    { text: "", expected: [] },
  ];
  for (const { text, expected } of cases) {
    expect([...collectLenientPlaceholders(text, collector)]).toEqual(expected);
    expect([...collectLenientPlaceholders(text, collector)]).toEqual(expected);
  }
});

test("has no lenient collector without known placeholders", () => {
  expect(buildLenientPlaceholderCollector(new Map())).toBeNull();
});

test("keeps literal bucket priority and escaped-length ordering", () => {
  const keys = ["[A]", "A?", "A", "[B]", "B"];
  const collector = buildLenientPlaceholderCollector(
    new Map(keys.map((key) => [key, key])),
  );
  expect(collector).not.toBeNull();
  if (collector === null) {
    return;
  }
  expect([...collectLenientPlaceholders("A? [A] B [B]", collector)]).toEqual([
    "A?",
    "[A]",
    "[B]",
  ]);
});

test("normalizes malformed UTF-16 at the matcher boundary", () => {
  const token = "custom\ud800token";
  const collector = buildLenientPlaceholderCollector(
    new Map([[token, "original"]]),
  );
  expect(collector).not.toBeNull();
  if (collector === null) {
    return;
  }
  expect([
    ...collectLenientPlaceholders(`before ${token} after`, collector),
  ]).toEqual([token]);
  expect([
    ...collectLenientPlaceholders("before custom\ufffdtoken after", collector),
  ]).toEqual([token]);
});
