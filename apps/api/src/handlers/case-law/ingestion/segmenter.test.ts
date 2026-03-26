import { describe, expect, test } from "bun:test";

import { segmentDecision } from "@/api/handlers/case-law/ingestion/segmenter";

describe("segmentDecision", () => {
  test("returns header-only for text without headings", () => {
    const text = "I. Žalovaný je povinen zaplatit.\nŽaloba je důvodná.";
    const sections = segmentDecision(text);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.type).toBe("header");
  });

  test("detects standalone Odůvodnění heading", () => {
    const text = "Výrok I.\n\nOdůvodnění:\nSoud konstatoval...";
    const sections = segmentDecision(text);
    const types = sections.map((s) => s.type);
    expect(types).toContain("argumentation");
  });

  test("detects spaced O d ů v o d n ě n í heading (NSS)", () => {
    const text = [
      "ČESKÁ REPUBLIKA",
      "R O Z S U D E K",
      "t a k t o :",
      "Kasační stížnost se zamítá.",
      "O d ů v o d n ě n í :",
      "Nejvyšší správní soud přezkoumal napadený rozsudek.",
    ].join("\n");

    const sections = segmentDecision(text);
    const types = sections.map((s) => s.type);
    expect(types).toContain("ruling");
    expect(types).toContain("argumentation");

    const arg = sections.find((s) => s.type === "argumentation");
    expect(arg?.text).toContain("Nejvyšší správní soud přezkoumal");
  });

  test("detects standalone takto: as ruling boundary", () => {
    const text = "Nejvyšší soud rozhodl\ntakto:\nKasační stížnost se zamítá.";
    const sections = segmentDecision(text);
    const types = sections.map((s) => s.type);
    expect(types).toContain("ruling");
  });

  test("detects spaced t a k t o : as ruling boundary", () => {
    const text =
      "Nejvyšší soud rozhodl\nt a k t o :\nKasační stížnost se zamítá.";
    const sections = segmentDecision(text);
    const types = sections.map((s) => s.type);
    expect(types).toContain("ruling");
  });

  test("detects ÚS Skutkové okolnosti as history", () => {
    const text = [
      "Ústavní stížnost se odmítá.",
      "Skutkové okolnosti případu a obsah napadených rozhodnutí",
      "Z ústavní stížnosti se podává...",
    ].join("\n");

    const sections = segmentDecision(text);
    const types = sections.map((s) => s.type);
    expect(types).toContain("history");
  });

  test("detects spaced P o u č e n í as footer", () => {
    const text = [
      "O d ů v o d n ě n í :",
      "Soud přezkoumal napadený rozsudek.",
      "P o u č e n í :",
      "Proti tomuto rozsudku nejsou opravné prostředky.",
    ].join("\n");

    const sections = segmentDecision(text);
    const types = sections.map((s) => s.type);
    expect(types).toContain("footer");
  });

  test("full NSS decision structure", () => {
    const text = [
      "č. j. 5 Afs 83/2005",
      "ČESKÁ REPUBLIKA",
      "R O Z S U D E K",
      "J M É N E M   R E P U B L I K Y",
      "Nejvyšší správní soud rozhodl v senátě",
      "t a k t o :",
      "I. Kasační stížnost se zamítá.",
      "II. Žádný z účastníků nemá právo na náhradu.",
      "O d ů v o d n ě n í :",
      "Rozhodnutím žalovaného byl potvrzen.",
      "Soud dospěl k závěru, že kasační stížnost není důvodná.",
      "P o u č e n í :",
      "Proti tomuto rozsudku nejsou opravné prostředky.",
    ].join("\n");

    const sections = segmentDecision(text);
    const types = sections.map((s) => s.type);

    expect(types).toEqual(["header", "ruling", "argumentation", "footer"]);

    const arg = sections.find((s) => s.type === "argumentation");
    expect(arg?.text).toContain("Rozhodnutím žalovaného");
    expect(arg?.text).toContain("kasační stížnost není důvodná");
  });

  test("returns empty array for empty input", () => {
    expect(segmentDecision("")).toEqual([]);
    expect(segmentDecision("  \n  ")).toEqual([]);
  });
});
