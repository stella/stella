import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parseCzList } from "../cz";
import { parseEuList } from "../eu";
import { DEFAULT_CUTOFF } from "../screening";
import { parseUnList } from "../un";
import { evaluate, generateCases } from "./evaluation";
import sample from "./sample.json";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures");
const CZ_FILE = "Vnitrostatni_sankcni_seznam_2026_07_23.csv";

const lists = [
  (
    await parseEuList(Bun.file(path.join(FIXTURES, "eu.xml")).stream())
  ).unwrap(),
  (
    await parseUnList(Bun.file(path.join(FIXTURES, "un.xml")).stream())
  ).unwrap(),
  parseCzList({
    csv: await Bun.file(path.join(FIXTURES, CZ_FILE)).text(),
    fileNameOrUrl: CZ_FILE,
  }).unwrap(),
];

// Written by `bun run evaluate -- --write-sample`, which uses these settings.
const SAMPLE_SEED = 7;
const SAMPLE_PER_CATEGORY = 6;

describe("screening evaluation sample", () => {
  test("is exactly what the generator produces from the fixtures", () => {
    const regenerated = generateCases(lists, {
      seed: SAMPLE_SEED,
      perCategory: SAMPLE_PER_CATEGORY,
    });
    // The sample is the generator's JSON output, so compare in that form: it
    // drops undefined fields and keeps the imported file's literal types out.
    expect(JSON.stringify(regenerated)).toBe(JSON.stringify(sample));
  });

  test("keeps recall and precision at the default cutoff", () => {
    const cases = generateCases(lists, {
      seed: SAMPLE_SEED,
      perCategory: SAMPLE_PER_CATEGORY,
    });
    expect(
      cases.some((testCase) => testCase.category === "stale-birth-date"),
    ).toBe(true);

    const [row] = evaluate(lists, cases, [DEFAULT_CUTOFF]).rows;
    expect(row?.recall).toBeGreaterThanOrEqual(0.95);
    expect(row?.falsePositiveRate).toBe(0);
  });
});
