import { describe, expect, test } from "bun:test";

import type { DocxBlock } from "@/api/lib/templates/house-style/folio-contract";
import {
  manifestOf,
  numbered,
} from "@/api/lib/templates/house-style/manifest.test-helpers";
import { numbersWhenRejected } from "@/api/lib/templates/house-style/tracked-views";

const BY = { author: "Jana Horáková", date: "2026-01-05T10:00:00Z" };

const blocksOf = (specs: Parameters<typeof manifestOf>[0]): DocxBlock[] =>
  manifestOf(specs).blocks;

const insertedWhole = (block: DocxBlock | undefined): void => {
  if (block !== undefined) {
    block.revisions = [
      { kind: "insertion", start: 0, end: block.text.length, ...BY },
    ];
  }
};

describe("numbersWhenRejected", () => {
  test("a clause inserted in front of another gives that other a lower number when rejected", () => {
    const kept = blocksOf([
      "Článek I.",
      numbered("1.", "Dodavatel dodá zboží."),
      numbered("2.", "Objednatel zboží převezme."),
      numbered("3.", "Objednatel zaplatí cenu."),
    ]);
    insertedWhole(kept[2]);
    const rejected = blocksOf([
      "Článek I.",
      numbered("1.", "Dodavatel dodá zboží."),
      numbered("2.", "Objednatel zaplatí cenu."),
    ]);
    // The heading has no number of a list: its first word stands for it.
    expect([...numbersWhenRejected(kept, rejected)]).toEqual([
      ["p0", "Článek"],
      ["p1", "1."],
      ["p3", "2."],
    ]);
  });

  test("a paragraph somebody reworded pairs with the one in its place", () => {
    const kept = blocksOf([
      numbered("1.", "Dodavatel dodá zboží."),
      numbered("2.", "Objednatel zboží bez zbytečného odkladu převezme."),
      numbered("3.", "Objednatel zaplatí cenu."),
    ]);
    const rejected = blocksOf([
      numbered("1.", "Dodavatel dodá zboží."),
      numbered("2.", "Objednatel zboží převezme."),
      numbered("3.", "Objednatel zaplatí cenu."),
    ]);
    expect(numbersWhenRejected(kept, rejected).get("p1")).toBe("2.");
  });

  test("paragraphs that cannot be told apart have no number", () => {
    // Two reworded paragraphs stand where the other reading has three.
    const kept = blocksOf([
      numbered("1.", "Úvod."),
      numbered("2.", "Nové znění první."),
      numbered("3.", "Nové znění druhé."),
      numbered("4.", "Závěr."),
    ]);
    const rejected = blocksOf([
      numbered("1.", "Úvod."),
      numbered("2.", "Staré znění první."),
      numbered("3.", "Staré znění druhé."),
      numbered("4.", "Staré znění třetí."),
      numbered("5.", "Závěr."),
    ]);
    expect([...numbersWhenRejected(kept, rejected)]).toEqual([
      ["p0", "1."],
      ["p3", "5."],
    ]);
    // Nothing to hold against: nothing is known.
    expect(numbersWhenRejected(kept, []).size).toBe(0);
  });

  test("the same words twice pair in order, and blank paragraphs are passed over", () => {
    const kept = blocksOf([
      numbered("1.", "Beze změny."),
      "",
      numbered("2.", "Beze změny."),
    ]);
    const rejected = blocksOf([
      numbered("1.", "Smazaný odstavec."),
      numbered("2.", "Beze změny."),
      numbered("3.", "Beze změny."),
    ]);
    expect([...numbersWhenRejected(kept, rejected)]).toEqual([
      ["p0", "2."],
      ["p2", "3."],
    ]);
  });
});
