/**
 * Fixture validation tests.
 *
 * Asserts that saved adapter fixtures still match the
 * expected IngestionResult shape. Catches schema drift
 * when a source API changes its response format.
 *
 * Run after `update-fixtures.ts` to verify the new
 * fixtures are valid. Also runs in CI to catch stale
 * fixtures that no longer parse correctly.
 */

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

type FixtureRecord = {
  adapter: string;
  recordedAt: string;
  page: {
    decisions: IngestionResult[];
    nextCursor: string | null;
  };
};

/** Load all *-page.json fixtures from __fixtures__/. */
const loadPageFixtures = async (): Promise<
  { filename: string; data: FixtureRecord }[]
> => {
  const results: {
    filename: string;
    data: FixtureRecord;
  }[] = [];

  const glob = new Glob("*-page.json");
  const fixturePath = FIXTURES_DIR.pathname.endsWith("/")
    ? FIXTURES_DIR.pathname
    : `${FIXTURES_DIR.pathname}/`;

  for await (const filename of glob.scan(fixturePath)) {
    const path = new URL(filename, FIXTURES_DIR);
    const text = await Bun.file(path).text();
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const data = JSON.parse(text) as FixtureRecord;
    results.push({ filename, data });
  }

  return results;
};

/** Validate a single IngestionResult has required fields. */
const validateDecision = (
  d: IngestionResult,
  index: number,
  adapter: string,
): void => {
  const prefix = `${adapter}[${index}]`;

  // Required fields
  expect(d.caseNumber, `${prefix}.caseNumber`).toBeTruthy();
  expect(d.court, `${prefix}.court`).toBeTruthy();
  expect(d.country, `${prefix}.country`).toMatch(/^[A-Z]{2,3}$/u);
  expect(d.language, `${prefix}.language`).toMatch(/^[a-z]{2}$/u);
  expect(d.rawHash, `${prefix}.rawHash`).toHaveLength(64);
  expect(typeof d.metadata, `${prefix}.metadata type`).toBe("object");

  // Date format if present
  if (d.decisionDate) {
    expect(d.decisionDate, `${prefix}.decisionDate`).toMatch(
      /^\d{4}-\d{2}-\d{2}$/u,
    );
  }

  // ECLI format if present
  if (d.ecli) {
    expect(d.ecli, `${prefix}.ecli`).toMatch(/^ECLI:/u);
  }

  // URL format if present
  if (d.sourceUrl) {
    expect(d.sourceUrl, `${prefix}.sourceUrl`).toMatch(/^https?:\/\//u);
  }

  if (d.documentUrl) {
    expect(d.documentUrl, `${prefix}.documentUrl`).toMatch(/^https?:\/\//u);
  }
};

describe("fixture validation", () => {
  test("all page fixtures have valid shape", async () => {
    const fixtures = await loadPageFixtures();

    expect(
      fixtures.length,
      "No page fixtures found. Run update-fixtures.ts first.",
    ).toBeGreaterThan(0);

    for (const { filename, data } of fixtures) {
      // Fixture metadata
      expect(data.adapter, `${filename}.adapter`).toBeTruthy();
      expect(data.recordedAt, `${filename}.recordedAt`).toMatch(
        /^\d{4}-\d{2}-\d{2}/u,
      );
      expect(data.page, `${filename}.page`).toBeDefined();
      expect(
        Array.isArray(data.page.decisions),
        `${filename}.page.decisions is array`,
      ).toBe(true);

      // At least one decision
      expect(
        data.page.decisions.length,
        `${filename} has decisions`,
      ).toBeGreaterThan(0);

      // Validate each decision
      for (let i = 0; i < data.page.decisions.length; i++) {
        const decision = data.page.decisions[i];
        if (!decision) {
          continue;
        }
        validateDecision(decision, i, data.adapter);
      }

      console.log(`  ${filename}: ${data.page.decisions.length} decisions OK`);
    }
  });

  test("fixtures are not stale (< 90 days)", async () => {
    const fixtures = await loadPageFixtures();

    expect(
      fixtures.length,
      "No page fixtures found. Run update-fixtures.ts first.",
    ).toBeGreaterThan(0);

    const now = Date.now();
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

    for (const { filename, data } of fixtures) {
      const recorded = new Date(data.recordedAt).getTime();
      const age = now - recorded;

      expect(
        age,
        `${filename} is stale (${Math.round(age / (24 * 60 * 60 * 1000))} days old)`,
      ).toBeLessThan(NINETY_DAYS);
    }
  });
});
