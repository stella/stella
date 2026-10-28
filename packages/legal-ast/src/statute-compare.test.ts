import { describe, expect, test } from "bun:test";

import type { Block } from "./document-ast";
import {
  compareStatuteBlocks,
  countStatuteChanges,
  groupCompareRows,
} from "./statute-compare";
import type { StatuteChangeCounts } from "./statute-compare";

const heading = (text: string): Block => ({
  type: "heading",
  id: `h:${text}`,
  anchorId: `h:${text}`,
  level: 4,
  inlines: [{ type: "text", text }],
  plainText: text,
});

const paragraph = (id: string, text: string): Block => ({
  type: "paragraph",
  id,
  anchorId: id,
  inlines: [{ type: "text", text }],
  plainText: text,
});

const counts = (older: readonly Block[], newer: readonly Block[]) =>
  countStatuteChanges(compareStatuteBlocks({ older, newer }).unwrap());

const NONE: StatuteChangeCounts = {
  provisions: { changed: 0, added: 0, removed: 0 },
  words: { inserted: 0, deleted: 0 },
};

/** Three provisions of a small act, each a heading and one paragraph. */
const ACT: readonly Block[] = [
  heading("§ 1"),
  paragraph("p1", "Tento zákon upravuje práva a povinnosti nájemce bytu."),
  heading("§ 2"),
  paragraph("p2", "Nájemce smí byt užívat k bydlení a k podnikání."),
  heading("§ 3"),
  paragraph("p3", "Pronajímatel odevzdá nájemci byt ve stavu způsobilém."),
];

describe("countStatuteChanges", () => {
  test("an unchanged consolidation counts nothing", () => {
    expect(counts(ACT, ACT)).toEqual(NONE);
  });

  test("whitespace alone counts nothing", () => {
    const respaced = ACT.map((block) =>
      block.id === "p2"
        ? paragraph("p2", "Nájemce  smí byt užívat k bydlení a k podnikání.")
        : block,
    );

    expect(counts(ACT, respaced)).toEqual(NONE);
  });

  test("a one-word rewording is one changed provision, however small", () => {
    const amended = ACT.map((block) =>
      block.id === "p2"
        ? paragraph("p2", "Nájemce nesmí byt užívat k bydlení a k podnikání.")
        : block,
    );

    expect(counts(ACT, amended)).toEqual({
      provisions: { changed: 1, added: 0, removed: 0 },
      words: { inserted: 1, deleted: 1 },
    });
  });

  test("a provision only the newer consolidation carries is added, its words inserted", () => {
    const extended = [
      ...ACT,
      heading("§ 4"),
      paragraph("p4", "Tento zákon nabývá účinnosti dnem vyhlášení."),
    ];

    expect(counts(ACT, extended)).toEqual({
      provisions: { changed: 0, added: 1, removed: 0 },
      words: { inserted: 8, deleted: 0 },
    });
  });

  test("a provision only the older consolidation carries is removed, its words deleted", () => {
    const repealed = ACT.slice(0, 4);

    expect(counts(ACT, repealed)).toEqual({
      provisions: { changed: 0, added: 0, removed: 1 },
      words: { inserted: 0, deleted: 9 },
    });
  });

  test("swapping the consolidations swaps additions for removals", () => {
    const repealed = ACT.slice(0, 4);
    const forward = counts(ACT, repealed);
    const backward = counts(repealed, ACT);

    expect(backward.provisions).toEqual({
      changed: forward.provisions.changed,
      added: forward.provisions.removed,
      removed: forward.provisions.added,
    });
    expect(backward.words).toEqual({
      inserted: forward.words.deleted,
      deleted: forward.words.inserted,
    });
  });

  test("a provision renumbered with its wording kept is one change of one word", () => {
    const relabelled = ACT.map((block) =>
      block.id === "h:§ 3" ? heading("§ 4") : block,
    );

    expect(counts(ACT, relabelled)).toEqual({
      provisions: { changed: 1, added: 0, removed: 0 },
      words: { inserted: 1, deleted: 1 },
    });
  });

  test("renumbering after an inserted provision counts what the side-by-side comparison shows", () => {
    // A new § 2 is inserted and the old § 2 and § 3 become § 3 and § 4. The
    // comparison aligns short provisions by their text, so it draws the old
    // § 2 rewritten as the new one, the old wording re-inserted under § 3,
    // and § 4 as a new heading over unchanged text. The counts are that
    // drawing, so a reader who opens the comparison finds exactly them.
    const renumbered = [
      heading("§ 1"),
      paragraph("p1", "Tento zákon upravuje práva a povinnosti nájemce bytu."),
      heading("§ 2"),
      paragraph("n2", "Nájemce oznámí pronajímateli počet osob v bytě."),
      heading("§ 3"),
      paragraph("p2", "Nájemce smí byt užívat k bydlení a k podnikání."),
      heading("§ 4"),
      paragraph("p3", "Pronajímatel odevzdá nájemci byt ve stavu způsobilém."),
    ];
    const rows = compareStatuteBlocks({
      older: ACT,
      newer: renumbered,
    }).unwrap();
    const result = countStatuteChanges(rows);

    expect(result).toEqual({
      provisions: { changed: 3, added: 0, removed: 0 },
      words: { inserted: 18, deleted: 9 },
    });
    expect(
      result.provisions.changed +
        result.provisions.added +
        result.provisions.removed,
    ).toBe(
      groupCompareRows(rows).filter((group) => group.status === "changed")
        .length,
    );
  });

  test("a paragraph that only moved inserts and deletes no words", () => {
    const moved = [
      heading("§ 1"),
      paragraph("p1", "Tento zákon upravuje práva a povinnosti nájemce bytu."),
      heading("§ 2"),
      heading("§ 3"),
      paragraph("p3", "Pronajímatel odevzdá nájemci byt ve stavu způsobilém."),
      paragraph("p2", "Nájemce smí byt užívat k bydlení a k podnikání."),
    ];

    const result = counts(ACT, moved);

    // Both provisions it moved between changed; no word was written anew.
    expect(result).toEqual({
      provisions: { changed: 2, added: 0, removed: 0 },
      words: { inserted: 0, deleted: 0 },
    });
  });
});
