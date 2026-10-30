import { describe, expect, test } from "bun:test";

import type { PaletteItem } from "./palette";
import {
  filterPalette,
  foldText,
  nextPaletteIndex,
  PALETTE_ENTITY_LIMIT,
} from "./palette";

const action = (key: string, title: string, terms: string[] = []) =>
  ({ key, kind: "action", terms, title }) satisfies PaletteItem;
const matter = (key: string, title: string, terms: string[] = []) =>
  ({ key, kind: "matter", terms, title }) satisfies PaletteItem;
const chat = (key: string, title: string) =>
  ({ key, kind: "chat", terms: [], title }) satisfies PaletteItem;

const keys = (items: readonly PaletteItem[]) => items.map((item) => item.key);

describe("the command palette", () => {
  const items: PaletteItem[] = [
    action("new-task", "New task", ["create", "todo"]),
    action("timers", "Timers", ["time", "clock"]),
    matter("m1", "Žaloba Novák", ["Novák s.r.o.", "2026/14"]),
    matter("m2", "Share purchase agreement", ["Acme"]),
    chat("c1", "Lease termination"),
    chat("c2", "Novák notice period"),
  ];

  test("with nothing typed lists the actions and the recent chats, not the matters", () => {
    expect(keys(filterPalette(items, "  "))).toEqual([
      "new-task",
      "timers",
      "c1",
      "c2",
    ]);
  });

  test("finds a matter typed without its accents, and by its client", () => {
    expect(keys(filterPalette(items, "zaloba"))).toEqual(["m1"]);
    expect(keys(filterPalette(items, "acme"))).toEqual(["m2"]);
  });

  test("needs every word, in any field", () => {
    expect(keys(filterPalette(items, "novak 2026"))).toEqual(["m1"]);
    expect(keys(filterPalette(items, "novak"))).toEqual(["m1", "c2"]);
  });

  test("puts a title that starts with the query before one that only contains it", () => {
    const listed = filterPalette(
      [
        chat("inside", "Draft a lease"),
        chat("word", "Notes on lease"),
        chat("start", "Lease renewal"),
      ],
      "lease",
    );
    expect(keys(listed)).toEqual(["start", "inside", "word"]);
  });

  test("answers an action's synonyms", () => {
    expect(keys(filterPalette(items, "clock"))).toEqual(["timers"]);
  });

  test("cuts matters to a few", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      matter(`m${index}`, `Matter ${index}`),
    );
    expect(filterPalette(many, "matter")).toHaveLength(PALETTE_ENTITY_LIMIT);
  });

  test("folds case and accents", () => {
    expect(foldText("Šárka ŘÍHOVÁ")).toBe("sarka rihova");
  });

  test("arrows wrap at either end", () => {
    expect(nextPaletteIndex(0, -1, 3)).toBe(2);
    expect(nextPaletteIndex(2, 1, 3)).toBe(0);
    expect(nextPaletteIndex(0, 1, 0)).toBe(0);
  });
});
