import { describe, expect, test } from "bun:test";

import { matchesComboboxItem } from "@/components/combobox-filter.logic";

/** Base UI's default filter: a base-sensitivity collator over equal windows. */
const BASE_COLLATOR = new Intl.Collator("de", {
  usage: "search",
  sensitivity: "base",
});

const collatorContains = (item: string, query: string) => {
  for (let start = 0; start <= item.length - query.length; start += 1) {
    if (
      BASE_COLLATOR.compare(item.slice(start, start + query.length), query) ===
      0
    ) {
      return true;
    }
  }
  return false;
};

describe("combobox item filter", () => {
  test("finds what a base collator misses", () => {
    expect(collatorContains("Hauptstraße", "strasse")).toBe(false);
    expect(matchesComboboxItem("Hauptstraße", "strasse")).toBe(true);
    expect(matchesComboboxItem("Antonín Dvořák", "DVORAK")).toBe(true);
    expect(matchesComboboxItem("İstanbul", "istanbul")).toBe(true);
    expect(matchesComboboxItem("Antonín Dvořák", "novak")).toBe(false);
  });

  test("reads the item text the way Base UI does", () => {
    const toString = (item: { name: string }) => item.name;
    expect(matchesComboboxItem({ name: "Élise" }, "elise", toString)).toBe(
      true,
    );
    expect(matchesComboboxItem({ label: "Čeština", value: "cs" }, "cest")).toBe(
      true,
    );
    expect(matchesComboboxItem({ value: "Łódź" }, "lodz")).toBe(true);
    expect(matchesComboboxItem(2026, "202")).toBe(true);
  });

  test("a blank query keeps every item; an item without text matches nothing else", () => {
    expect(matchesComboboxItem({ id: 1 }, "  ")).toBe(true);
    expect(matchesComboboxItem({ id: 1 }, "1")).toBe(false);
    expect(matchesComboboxItem(null, "a")).toBe(false);
  });
});
