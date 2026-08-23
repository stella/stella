import { describe, expect, test } from "bun:test";

import type { GroundTruthDocument } from "../ground-truth";
import { loadGroundTruth } from "../ground-truth";
import { aggregate, mapPredictions, scoreCorpus } from "../metrics";
import { STELLA_MAPPING } from "../taxonomy";

const doc = (
  entities: GroundTruthDocument["entities"],
): GroundTruthDocument => ({
  id: "d",
  language: "en",
  title: "t",
  text: "x".repeat(100),
  entities,
});

const preds = (
  spans: { start: number; end: number; label: string }[],
): ReadonlyMap<
  string,
  { start: number; end: number; label: string; text: string }[]
> => new Map([["d", spans.map((s) => ({ ...s, text: "" }))]]);

// Identity mapping so native labels equal common labels in these unit tests.
const IDENTITY = { person: "person", organization: "organization" } as const;

describe("span matching", () => {
  test("overlap >= 0.5 counts as a true positive, below does not", () => {
    const gold = doc([{ start: 0, end: 10, label: "person", text: "" }]);
    // pred [0,20): intersection 10, union 20, IoU 0.5 -> matches (inclusive).
    const hit = scoreCorpus(
      [gold],
      preds([{ start: 0, end: 20, label: "person" }]),
      IDENTITY,
      "overlap",
    );
    expect(aggregate(hit).tp).toBe(1);
    // pred [0,21): intersection 10, union 21, IoU ~0.476 < 0.5.
    const miss = scoreCorpus(
      [gold],
      preds([{ start: 0, end: 21, label: "person" }]),
      IDENTITY,
      "overlap",
    );
    const m = aggregate(miss);
    expect(m.tp).toBe(0);
    expect(m.fp).toBe(1);
    expect(m.fn).toBe(1);
  });

  test("label mismatch never matches even with full overlap", () => {
    const gold = doc([{ start: 0, end: 10, label: "person", text: "" }]);
    const scored = scoreCorpus(
      [gold],
      preds([{ start: 0, end: 10, label: "organization" }]),
      IDENTITY,
      "overlap",
    );
    const a = aggregate(scored);
    expect(a.tp).toBe(0);
    expect(a.fp).toBe(1);
    expect(a.fn).toBe(1);
  });

  test("greedy assignment is one-to-one", () => {
    const gold = doc([{ start: 0, end: 10, label: "person", text: "" }]);
    // Two predictions overlapping the single gold: one tp, one fp.
    const scored = scoreCorpus(
      [gold],
      preds([
        { start: 0, end: 10, label: "person" },
        { start: 1, end: 11, label: "person" },
      ]),
      IDENTITY,
      "overlap",
    );
    const a = aggregate(scored);
    expect(a.tp).toBe(1);
    expect(a.fp).toBe(1);
    expect(a.fn).toBe(0);
  });

  test("exact mode requires identical boundaries", () => {
    const gold = doc([{ start: 0, end: 10, label: "person", text: "" }]);
    const off = preds([{ start: 0, end: 9, label: "person" }]);
    expect(aggregate(scoreCorpus([gold], off, IDENTITY, "overlap")).tp).toBe(1);
    expect(aggregate(scoreCorpus([gold], off, IDENTITY, "exact")).tp).toBe(0);
  });
});

describe("mapping", () => {
  test("null-mapped native labels are dropped, others collapse to common labels", () => {
    const mapped = mapPredictions(
      [
        { start: 0, end: 1, label: "iban", text: "" },
        { start: 2, end: 3, label: "passport number", text: "" },
        { start: 4, end: 5, label: "misc", text: "" },
      ],
      STELLA_MAPPING,
    );
    expect(mapped.map((m) => m.label)).toEqual(["id-number", "id-number"]);
  });
});

describe("aggregate", () => {
  test("precision, recall, and F1 follow from the confusion counts", () => {
    const gold = doc([
      { start: 0, end: 10, label: "person", text: "" },
      { start: 20, end: 30, label: "person", text: "" },
    ]);
    const scored = scoreCorpus(
      [gold],
      preds([
        { start: 0, end: 10, label: "person" }, // tp
        { start: 50, end: 60, label: "person" }, // fp
      ]),
      IDENTITY,
      "overlap",
    );
    const a = aggregate(scored);
    expect(a).toMatchObject({ tp: 1, fp: 1, fn: 1 });
    expect(a.precision).toBeCloseTo(0.5, 5);
    expect(a.recall).toBeCloseTo(0.5, 5);
    expect(a.f1).toBeCloseTo(0.5, 5);
  });
});

describe("ground truth fixtures", () => {
  test("every labelled span quotes the document verbatim at its offsets", async () => {
    const docs = await loadGroundTruth();
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) {
      for (const e of d.entities) {
        expect(d.text.slice(e.start, e.end)).toBe(e.text);
      }
    }
  });

  test("contextual party fixtures score both person and organization parties", async () => {
    const docs = await loadGroundTruth();
    const partyDocs = docs.filter((fixture) =>
      fixture.id.includes("contextual-party"),
    );

    expect(partyDocs.length).toBeGreaterThan(0);
    for (const fixture of partyDocs) {
      const labels = new Set(fixture.entities.map((entity) => entity.label));
      expect(labels).toContain("person");
      expect(labels).toContain("organization");
    }
  });
});

import { convertCodePointSpans } from "../adapters/python";

test("python code-point spans convert to utf-16 offsets", () => {
  const text = "\u{1F600}\u{1F600} Jan Novak lives here";
  // Code points: two emoji (1 each) + space = entity starts at cp 3.
  const spans = convertCodePointSpans(text, [
    { label: "person", start: 3, end: 12, text: "Jan Novak" },
  ]);
  const first = spans[0];
  expect(first?.start).toBe(5);
  expect(first?.end).toBe(14);
  expect(text.slice(first?.start, first?.end)).toBe("Jan Novak");
});

test("bmp-only text spans are unchanged by conversion", () => {
  const text = "Jan Novak";
  const spans = convertCodePointSpans(text, [
    { label: "person", start: 0, end: 9, text: "Jan Novak" },
  ]);
  expect(spans[0]?.start).toBe(0);
  expect(spans[0]?.end).toBe(9);
});
