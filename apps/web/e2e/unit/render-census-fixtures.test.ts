import { describe, expect, test } from "bun:test";

import {
  createOutlinePages,
  INSERTED_TEXT,
  legalClause,
  REVIEW_COLUMNS,
  reviewRecord,
} from "../agent/render-census/legal-fixtures";

const PLACEHOLDER_TEXT =
  /\b(?:lorem ipsum|demo|test \d+|sample|placeholder|foo|todo)\b/iu;

describe("legal render census fixtures", () => {
  test("the outline has eighty pages and 230 distinct legal clauses", () => {
    const pages = createOutlinePages();
    const clauses = pages.flat();
    expect(pages).toHaveLength(80);
    expect(clauses).toHaveLength(230);
    expect(pages.every((page) => page.length >= 2 && page.length <= 3)).toBe(
      true,
    );
    expect(new Set(clauses.map(({ heading }) => heading)).size).toBe(230);
    expect(new Set(clauses.map(({ paragraph }) => paragraph)).size).toBe(230);
    for (const { heading, paragraph } of clauses) {
      expect(heading).not.toMatch(PLACEHOLDER_TEXT);
      expect(paragraph).not.toMatch(PLACEHOLDER_TEXT);
      expect(paragraph.length).toBeGreaterThan(500);
    }
    expect(INSERTED_TEXT).toHaveLength(20);
  });

  test("500 review documents populate every manual column with legal content", () => {
    const rows = Array.from({ length: 500 }, (_, index) =>
      reviewRecord({ index, rowCount: 500 }),
    );
    expect(REVIEW_COLUMNS).toHaveLength(9);
    expect(new Set(rows.map(({ name }) => name)).size).toBe(500);
    expect(
      new Set(rows.map(({ values }) => values["Věcná poznámka"])).size,
    ).toBe(500);
    for (const { name, values } of rows) {
      expect(name).not.toMatch(PLACEHOLDER_TEXT);
      expect(Object.keys(values).toSorted()).toEqual(REVIEW_COLUMNS.toSorted());
      for (const value of Object.values(values)) {
        expect(value.length).toBeGreaterThan(0);
        expect(value).not.toMatch(PLACEHOLDER_TEXT);
      }
    }
  });

  test("seeded content is independent of generation order and subset size", () => {
    const records = Array.from({ length: 500 }, (_, index) => ({
      clause: legalClause(index),
      row: reviewRecord({ index, rowCount: 500 }),
    }));
    for (let index = records.length - 1; index >= 0; index--) {
      expect({
        clause: legalClause(index),
        row: reviewRecord({ index, rowCount: 500 }),
      }).toEqual(records.at(index));
      expect(reviewRecord({ index, rowCount: 50 }).name).toBe(
        reviewRecord({ index, rowCount: 500 }).name,
      );
      expect(
        reviewRecord({ index, rowCount: 50 }).values["Věcná poznámka"],
      ).toBe(reviewRecord({ index, rowCount: 500 }).values["Věcná poznámka"]);
    }
    expect(createOutlinePages()).toEqual(createOutlinePages());
  });
});
