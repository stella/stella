import { extractDefinedTerms, findCoreferenceSpans } from "./coreference";
import type { Entity } from "./types";
import { DETECTION_SOURCES } from "./types";

const personEntity = (start: number, end: number, text: string): Entity => ({
  start,
  end,
  label: "person",
  text,
  score: 0.9,
  source: DETECTION_SOURCES.NER,
});

describe("extractDefinedTerms()", () => {
  it("extracts Czech dále jen alias", () => {
    const text = 'Ing. Jan Novák (dále jen „Prodávající") prodává';
    const entity = personEntity(0, 14, "Ing. Jan Novák");
    const terms = extractDefinedTerms(text, [entity]);
    expect(terms).toHaveLength(1);
    expect(terms[0].alias).toBe("Prodávající");
    expect(terms[0].label).toBe("person");
  });

  it("extracts German nachfolgend alias", () => {
    const text = 'Dr. Heinrich Müller (nachfolgend „der Vermieter")';
    const entity = personEntity(0, 19, "Dr. Heinrich Müller");
    const terms = extractDefinedTerms(text, [entity]);
    expect(terms).toHaveLength(1);
    expect(terms[0].alias).toBe("der Vermieter");
  });

  it("extracts English hereinafter alias", () => {
    const text = 'John Smith (hereinafter "the Buyer") agrees';
    const entity = personEntity(0, 10, "John Smith");
    const terms = extractDefinedTerms(text, [entity]);
    expect(terms).toHaveLength(1);
    expect(terms[0].alias).toBe("the Buyer");
  });

  it("extracts German im Folgenden alias", () => {
    const text = 'Müller GmbH (im Folgenden „der Mieter") mietet';
    const entity = personEntity(0, 11, "Müller GmbH");
    const terms = extractDefinedTerms(text, [entity]);
    expect(terms).toHaveLength(1);
    expect(terms[0].alias).toBe("der Mieter");
  });

  it("deduplicates identical aliases", () => {
    const text =
      'Jan Novák (dále jen „Prodávající") a ' +
      'Jan Novák (dále jen „Prodávající")';
    const e1 = personEntity(0, 9, "Jan Novák");
    const e2 = personEntity(37, 46, "Jan Novák");
    const terms = extractDefinedTerms(text, [e1, e2]);
    expect(terms).toHaveLength(1);
  });

  it("returns empty for text without definitions", () => {
    const text = "Pan Novák podepsal smlouvu.";
    const entity = personEntity(4, 9, "Novák");
    expect(extractDefinedTerms(text, [entity])).toHaveLength(0);
  });

  it("ignores very short aliases", () => {
    const text = 'Jan Novák (dále jen „X")';
    const entity = personEntity(0, 9, "Jan Novák");
    const terms = extractDefinedTerms(text, [entity]);
    expect(terms).toHaveLength(0);
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
    expect(spans[0].source).toBe("coreference");
    expect(spans[0].score).toBe(0.95);
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
    expect(text.slice(spans[0].start, spans[0].end)).toBe("der Vermieter");
    expect(text.slice(spans[1].start, spans[1].end)).toBe("der Vermieter");
  });
});
