import { expect, test } from "bun:test";

import {
  buildScreeningIndex,
  DEFAULT_CUTOFF,
  SANCTIONS_SOURCES,
  screen,
} from "@stll/sanctions";
import type { ParsedList, ScreeningQuery } from "@stll/sanctions";

import { createSanctionsMatcherPool } from "./matcher-pool";
import type { SanctionsMatcherRequest } from "./matcher-protocol";

const personList = (name: string): ParsedList => ({
  version: { source: "eu", publishedAt: "2026-09-20", fileId: null },
  entries: [
    {
      source: "eu",
      issuer: SANCTIONS_SOURCES.eu.issuer,
      sourceId: "multilingual-person",
      referenceNumber: null,
      entityType: "person",
      names: [{ name, quality: "strong" }],
      birthDates: [
        { precision: "day", year: 1960, month: 5, day: 12, circa: false },
      ],
      nationalities: [{ code: "CZ", name: "Czechia" }],
      identifiers: [],
      addresses: [],
      programme: null,
      legalBasis: null,
      listedOn: null,
      sourceUrl: "https://lists.example/eu",
    },
  ],
});

const multilingualCases = [
  {
    name: "Čeněk Říha",
    listed: "Čeněk Říha",
    birthDate: { year: 1960 },
    nationalityCodes: ["CZ"],
    dateEvidence: "match",
    nationalityEvidence: "match",
  },
  {
    name: "Ján Šťastný",
    listed: "Ján Šťastný",
    birthDate: { year: 1960, month: 5 },
    nationalityCodes: ["SK"],
    dateEvidence: "match",
    nationalityEvidence: "mismatch",
  },
  {
    name: "Иван Сидоров",
    listed: "Иван Сидоров",
    birthDate: { year: 1960, month: 5, day: 12 },
    nationalityCodes: ["CZ"],
    dateEvidence: "match",
    nationalityEvidence: "match",
  },
  {
    name: "Ivan Sidorov",
    listed: "Иван Сидоров",
    birthDate: { year: 1971 },
    nationalityCodes: ["CZ"],
    dateEvidence: "mismatch",
    nationalityEvidence: "match",
  },
  {
    name: "Ľuboš Ďur",
    listed: "Ľuboš Ďur",
    birthDate: { year: 1960 },
    nationalityCodes: ["CZ"],
    dateEvidence: "match",
    nationalityEvidence: "match",
  },
  {
    name: "Jána Šťastného",
    listed: "Jána Šťastného",
    birthDate: { year: 1960 },
    nationalityCodes: ["CZ"],
    dateEvidence: "match",
    nationalityEvidence: "match",
  },
] as const;

test.each(multilingualCases)(
  "real worker preserves multilingual identity and partial-date evidence ($name)",
  async (fixture) => {
    expect("Čeněk Říha".normalize("NFD")).not.toBe("Čeněk Říha");
    const pool = createSanctionsMatcherPool({ size: 1, deadlineMs: 5000 });
    const list = personList(fixture.listed);
    const index = buildScreeningIndex([list]);
    try {
      for (const name of [fixture.name, fixture.name.normalize("NFD")]) {
        const query = {
          name,
          entityType: "person",
          birthDate: fixture.birthDate,
          nationalityCodes: [...fixture.nationalityCodes],
        } as const satisfies ScreeningQuery;
        const expected = screen(index, query, {
          cutoff: DEFAULT_CUTOFF,
          limit: 10,
        }).unwrap();
        expect(expected.possibleMatches.at(0)?.entry.sourceId).toBe(
          "multilingual-person",
        );
        expect(
          expected.possibleMatches.at(0)?.evidence.nameScore,
        ).toBeGreaterThan(0);
        expect(expected.possibleMatches.at(0)?.evidence.birthDate).toBe(
          fixture.dateEvidence,
        );
        expect(expected.possibleMatches.at(0)?.evidence.nationality).toBe(
          fixture.nationalityEvidence,
        );
        const request = {
          source: "eu",
          editionId: "multilingual",
          query,
          list,
          cutoff: DEFAULT_CUTOFF,
          limit: 10,
        } as const satisfies SanctionsMatcherRequest;
        expect(
          await pool.run(async (session) => await session.match(request)),
        ).toEqual({ status: "screened", result: expected });
        expect(
          await pool.run(
            async (session) => await session.match({ ...request, list: null }),
          ),
        ).toEqual({ status: "screened", result: expected });
      }
    } finally {
      await pool.close();
    }
  },
);
