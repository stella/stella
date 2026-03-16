import { describe, expect, it } from "bun:test";

import {
  DETECTION_SOURCES,
  extractDefinedTerms,
  findCoreferenceSpans,
} from "@stella/anonymize";
import type { Entity } from "@stella/anonymize";

const personEntity = (start: number, end: number, text: string): Entity => ({
  start,
  end,
  label: "person",
  text,
  score: 0.9,
  source: DETECTION_SOURCES.NER,
});

describe("extractDefinedTerms()", () => {
  it("extracts Czech dále jen alias + declension variants", () => {
    const text = 'Ing. Jan Novák (dále jen „Prodávající") prodává';
    const entity = personEntity(0, 14, "Ing. Jan Novák");
    const terms = extractDefinedTerms(text, [entity]);
    const aliases = terms.map((t) => t.alias);
    // Definition alias
    expect(aliases).toContain("Prodávající");
    // Czech declension variants for "Novák"
    expect(aliases).toContain("Novákovi");
    expect(terms.length).toBeGreaterThanOrEqual(2);
    expect(terms[0]?.label).toBe("person");
  });

  it("extracts German nachfolgend alias", () => {
    const text = 'Dr. Heinrich Müller (nachfolgend „der Vermieter")';
    const entity = personEntity(0, 19, "Dr. Heinrich Müller");
    const terms = extractDefinedTerms(text, [entity]);
    const aliases = terms.map((t) => t.alias);
    expect(aliases).toContain("der Vermieter");
    // Also generates Czech declension variants for
    // multi-word person names
    expect(terms.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts English hereinafter alias", () => {
    const text = 'John Smith (hereinafter "the Buyer") agrees';
    const entity = personEntity(0, 10, "John Smith");
    const terms = extractDefinedTerms(text, [entity]);
    const aliases = terms.map((t) => t.alias);
    expect(aliases).toContain("the Buyer");
    expect(terms.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts German im Folgenden alias", () => {
    const text = 'Müller GmbH (im Folgenden „der Mieter") mietet';
    const entity = personEntity(0, 11, "Müller GmbH");
    const terms = extractDefinedTerms(text, [entity]);
    const aliases = terms.map((t) => t.alias);
    expect(aliases).toContain("der Mieter");
    expect(terms.length).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates identical aliases", () => {
    const text =
      'Jan Novák (dále jen „Prodávající") a ' +
      'Jan Novák (dále jen „Prodávající")';
    const e1 = personEntity(0, 9, "Jan Novák");
    const e2 = personEntity(37, 46, "Jan Novák");
    const terms = extractDefinedTerms(text, [e1, e2]);
    // 1 alias "Prodávající" + Czech variants (deduplicated across both entities)
    const aliases = terms.map((t) => t.alias);
    expect(aliases).toContain("Prodávající");
    // Variants should not be duplicated
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("returns Czech declension variants for person entities", () => {
    const text = "Pan Novák podepsal smlouvu.";
    const entity = personEntity(4, 9, "Novák");
    const terms = extractDefinedTerms(text, [entity]);
    // No definition pattern, but Czech declension generates variants
    const aliases = terms.map((t) => t.alias);
    expect(aliases).toContain("Novákovi");
    expect(aliases).toContain("Novákem");
  });

  it("ignores very short aliases but generates Czech variants", () => {
    const text = 'Jan Novák (dále jen „X")';
    const entity = personEntity(0, 9, "Jan Novák");
    const terms = extractDefinedTerms(text, [entity]);
    // "X" is too short to be an alias, but Czech variants are generated
    const aliases = terms.map((t) => t.alias);
    expect(aliases).not.toContain("X");
    expect(aliases.length).toBeGreaterThan(0);
  });
});

describe("findCoreferenceSpans()", () => {
  it("finds all occurrences of an alias", () => {
    const text = "Prodávající prodává. Prodávající potvrzuje.";
    const terms = [
      {
        alias: "Prodávající",
        label: "person",
        definitionStart: 0,
      },
    ];
    const spans = findCoreferenceSpans(text, terms);
    expect(spans).toHaveLength(2);
    expect(spans[0]?.source).toBe("coreference");
    expect(spans[0]?.score).toBe(0.95);
  });

  it("returns correct offsets for each occurrence", () => {
    const text = "AAA der Vermieter BBB der Vermieter CCC";
    const terms = [
      {
        alias: "der Vermieter",
        label: "person",
        definitionStart: 0,
      },
    ];
    const spans = findCoreferenceSpans(text, terms);
    expect(text.slice(spans[0]?.start, spans[0]?.end)).toBe("der Vermieter");
    expect(text.slice(spans[1]?.start, spans[1]?.end)).toBe("der Vermieter");
  });
});
