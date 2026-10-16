import { panic } from "better-result";
import { expect, test } from "bun:test";
import * as fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { SanctionsEntry } from "./entry";
import {
  MAX_QUERY_TOKENS,
  hasExcessQueryTokens,
  nameReading,
} from "./normalise";
import { buildScreeningIndex, screen, screeningWorkBound } from "./screening";

// The public search accepts names of at most this many UTF-16 code units.
const MAX_QUERY_CHARACTERS = 512;

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

test("valid queries up to the input limits complete within the static work bound", () => {
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
      .map((tokens) => tokens.join(" ").slice(0, MAX_QUERY_CHARACTERS)),
    fc
      .array(fc.constantFrom(...vocabulary), {
        minLength: 1,
        maxLength: MAX_QUERY_TOKENS,
      })
      .map((tokens) => tokens.join(" ").slice(0, MAX_QUERY_CHARACTERS)),
    fc.constant("a".repeat(MAX_QUERY_CHARACTERS)),
  );
  const assertComplete = (name: string) => {
    expect(name.length).toBeLessThanOrEqual(MAX_QUERY_CHARACTERS);
    expect(hasExcessQueryTokens(name, "person")).toBe(false);
    const expectedBound = screeningWorkBound({
      index,
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
  // Both input limits at once: the most tokens, each as long as fits.
  assertComplete(
    Array.from({ length: MAX_QUERY_TOKENS }, (_, token) =>
      Array.from({ length: 20 }, (_letter, letter) =>
        String.fromCodePoint(97 + ((token * 7 + letter * 11) % 26)),
      ).join(""),
    )
      .join(" ")
      .slice(0, MAX_QUERY_CHARACTERS),
  );
  assertComplete(
    Array.from({ length: MAX_QUERY_CHARACTERS }, (_, id) =>
      String.fromCodePoint(0x34_00 + id),
    ).join(""),
  );
  assertProperty(
    "valid queries up to the input limits complete within the static work bound",
    fc.property(validName, assertComplete),
    { numRuns: 12 },
  );
}, 60_000);

test("a budget below the needed work reports work-limit, never a partial result", () => {
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
  for (const maxWork of [1, Math.floor(spent / 2), spent - 1]) {
    const limited = screen(index, query, { cutoff: 0.8, maxWork });
    expect(limited.isErr() && limited.error.code).toBe("work-limit");
  }
});

test("dense neighbourhoods and repeated self-joins stay within the static work bound", () => {
  const letters = "abcdefghijklmnopqrst";
  const entries = Array.from(letters).flatMap((first, row) =>
    Array.from(letters).map((second, column) => ({
      ...listed(row * letters.length + column),
      entityType: "person" as const,
      names: [
        { name: `Novak${first}${second} Ali Ali`, quality: "strong" as const },
        { name: `Ali Ali Ali Novak${second}`, quality: "weak" as const },
      ],
    })),
  );
  const index = buildScreeningIndex([
    {
      version: { source: "eu", publishedAt: "2026-10-15", fileId: null },
      entries,
    },
  ]);
  for (const name of ["Novaka Ali Ali", "Ali Ali Ali Ali", "Novak Novaka"]) {
    let spent = 0;
    let limit = 0;
    const result = screen(
      index,
      { name, entityType: "person" },
      {
        cutoff: 0,
        limit: index.entries.length,
        onWork: (usage) => {
          spent = usage.spent;
          limit = usage.limit;
        },
      },
    ).unwrap();
    expect(result.truncated).toBe(false);
    expect(result.totalMatches).toBeGreaterThan(64);
    expect(spent).toBeLessThanOrEqual(limit);
  }
}, 60_000);
