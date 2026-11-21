import { panic } from "better-result";
import { expect, test } from "bun:test";
import * as fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { SanctionsEntry } from "./entry";
import {
  hasExcessQueryTokens,
  MAX_QUERY_TOKENS,
  nameReading,
} from "./normalise";
import { buildScreeningIndex, screen } from "./screening";
import { screeningWorkBound } from "./screening-work-bound";

const vocabulary = [
  "Mohammed",
  "Muhammad",
  "Ali",
  "Hassan",
  "Ivan",
  "Petrov",
  "Zhang",
  "Wang",
  "Jiří",
  "Novák",
  "Štefan",
  "Kováč",
  "Trading",
  "Global",
  "Shipping",
  "Energy",
];

const listed = (id: number): SanctionsEntry => ({
  source: "eu",
  issuer: "EU",
  sourceId: String(id),
  referenceNumber: null,
  entityType: id % 2 === 0 ? "person" : "organisation",
  names: [
    {
      name: `${vocabulary.at(id % vocabulary.length) ?? panic("Missing given name")} ${vocabulary.at(Math.floor(id / vocabulary.length) % vocabulary.length) ?? panic("Missing family name")}`,
      quality: "strong",
    },
  ],
  birthDates: [],
  nationalities: [],
  identifiers: [],
  addresses: [],
  programme: null,
  legalBasis: null,
  listedOn: null,
  sourceUrl: "https://lists.example/eu",
});

test("valid queries complete within the static work bound at real edition cardinality", () => {
  const index = buildScreeningIndex([
    {
      version: { source: "eu", publishedAt: "2026-10-15", fileId: null },
      entries: Array.from({ length: 20_000 }, (_, id) => listed(id)),
    },
  ]);
  const randomToken = fc
    .array(fc.constantFrom(...Array.from("abcdeČřéعليИван中文")), {
      minLength: 1,
      maxLength: 32,
    })
    .map((characters) => characters.join(""));
  const validName = fc.oneof(
    fc
      .array(randomToken, { minLength: 1, maxLength: MAX_QUERY_TOKENS })
      .map((tokens) => tokens.join(" ").slice(0, 512)),
    fc
      .array(fc.constantFrom(...vocabulary), {
        minLength: 1,
        maxLength: MAX_QUERY_TOKENS,
      })
      .map((tokens) => tokens.join(" ").slice(0, 512)),
    // Character boundary, with a deletion neighbourhood cheap enough for a unit test.
    fc.constant("a".repeat(512)),
  );
  const assertComplete = (name: string) => {
    expect(hasExcessQueryTokens(name, "person")).toBe(false);
    const expectedBound = screeningWorkBound({
      stats: index.workStats,
      readings: [
        nameReading(name, "organisation"),
        nameReading(name, "person"),
      ],
      identifierCount: 0,
    });
    let spent = 0;
    let limit = 0;
    const result = screen(
      index,
      { name },
      {
        cutoff: 0.8,
        limit: index.entries.length,
        onWork: (usage) => {
          spent = usage.spent;
          limit = usage.limit;
        },
      },
    ).unwrap();
    expect(result.truncated).toBe(false);
    expect(limit).toBe(expectedBound);
    expect(spent).toBeLessThanOrEqual(limit);
    expect(spent).toBeGreaterThan(0);
  };
  assertComplete(
    Array.from({ length: 512 }, (_, id) =>
      String.fromCodePoint(0x34_00 + id),
    ).join(""),
  );
  assertProperty(
    "valid queries complete within the static work bound at real edition cardinality",
    fc.property(validName, assertComplete),
    { numRuns: 12 },
  );
}, 30_000);

test("a tighter explicit work budget still reports exhaustion", () => {
  const index = buildScreeningIndex([
    {
      version: { source: "eu", publishedAt: "2026-10-15", fileId: null },
      entries: Array.from({ length: 128 }, (_, id) => listed(id)),
    },
  ]);
  const query = { name: "Mohammed Ali" };
  let spent = 0;
  const complete = screen(index, query, {
    cutoff: 0.8,
    limit: index.entries.length,
    onWork: (usage) => {
      spent = usage.spent;
    },
  }).unwrap();
  expect(complete.truncated).toBe(false);
  expect(spent).toBeGreaterThan(1);
  const limited = screen(index, query, { cutoff: 0.8, maxWork: spent - 1 });
  expect(limited.isErr()).toBe(true);
  if (limited.isErr()) {
    expect(limited.error.code).toBe("work-limit");
  }
});
