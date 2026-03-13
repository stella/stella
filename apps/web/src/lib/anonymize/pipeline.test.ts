import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { extractDefinedTerms, findCoreferenceSpans } from "./coreference";
import { filterFalsePositives } from "./false-positive-filter";
import { mergeAndDedup } from "./pipeline";
import { redactText } from "./redact";
import { detectRegexPii } from "./regex-patterns";
import { detectTriggerPhrases } from "./trigger-phrases";
import type { Entity } from "./types";
import { DETECTION_SOURCES } from "./types";

const FIXTURES_DIR = resolve(import.meta.dirname, "__fixtures__");

const readFixture = (name: string): string =>
  readFileSync(resolve(FIXTURES_DIR, name), "utf8");

// ── Unit tests for mergeAndDedup ──────────────────────

describe("mergeAndDedup()", () => {
  const entity = (
    start: number,
    end: number,
    score: number,
    source: Entity["source"] = DETECTION_SOURCES.REGEX,
  ): Entity => ({
    start,
    end,
    label: "person",
    text: `e-${start}`,
    score,
    source,
  });

  it("merges non-overlapping entities from two layers", () => {
    const a = [entity(0, 5, 1)];
    const b = [entity(10, 15, 0.8, DETECTION_SOURCES.NER)];
    const merged = mergeAndDedup(a, b);
    expect(merged).toHaveLength(2);
  });

  it("keeps higher score on overlap", () => {
    const a = [entity(0, 10, 0.6)];
    const b = [entity(5, 15, 0.9, DETECTION_SOURCES.NER)];
    const merged = mergeAndDedup(a, b);
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBe(0.9);
  });

  it("sorts output by start offset", () => {
    const a = [entity(20, 30, 1)];
    const b = [entity(5, 10, 0.8)];
    const merged = mergeAndDedup(a, b);
    expect(merged[0].start).toBe(5);
    expect(merged[1].start).toBe(20);
  });
});

// ── Fixture-based integration tests ──────────────────

/**
 * Run the non-NER parts of the pipeline on a fixture
 * file: trigger phrases, regex, false-positive filtering,
 * coreference, merge, and redaction.
 */
const runOfflinePipeline = (
  text: string,
): {
  entities: Entity[];
  redacted: string;
} => {
  const triggers = detectTriggerPhrases(text);
  const regex = detectRegexPii(text);
  const rawMerged = mergeAndDedup(triggers, regex);
  const filtered = filterFalsePositives(rawMerged);

  const terms = extractDefinedTerms(text, filtered);
  const corefSpans = findCoreferenceSpans(text, terms);
  const entities = mergeAndDedup(filtered, corefSpans);

  const { redactedText } = redactText(text, entities);
  return { entities, redacted: redactedText };
};

describe("pipeline integration: Czech purchase agreement", () => {
  const text = readFixture("czech-purchase-agreement.txt");
  const { entities, redacted } = runOfflinePipeline(text);

  it("detects titled persons", () => {
    const persons = entities.filter((e) => e.label === "person");
    const texts = persons.map((e) => e.text);
    expect(texts.some((t) => t.includes("Tomáš Procházka"))).toBeTruthy();
    expect(texts.some((t) => t.includes("Marie Dvořáková"))).toBeTruthy();
  });

  it("detects IČO and DIČ via triggers", () => {
    const labels = entities.map((e) => e.label);
    expect(labels).toContain("registration number");
    expect(labels).toContain("tax identification number");
  });

  it("detects IBAN", () => {
    expect(entities.some((e) => e.label === "iban")).toBeTruthy();
  });

  it("detects emails", () => {
    const emails = entities.filter((e) => e.label === "email address");
    expect(emails.length).toBeGreaterThanOrEqual(2);
  });

  it("detects phone numbers", () => {
    expect(entities.some((e) => e.label === "phone number")).toBeTruthy();
  });

  it("detects Czech birth number", () => {
    expect(entities.some((e) => e.label === "czech birth number")).toBeTruthy();
  });

  it("extracts Prodávající as coreference alias", () => {
    const coref = entities.filter(
      (e) => e.source === DETECTION_SOURCES.COREFERENCE,
    );
    expect(coref.some((e) => e.text === "Prodávající")).toBeTruthy();
  });

  it("extracts Kupující as coreference alias", () => {
    const coref = entities.filter(
      (e) => e.source === DETECTION_SOURCES.COREFERENCE,
    );
    expect(coref.some((e) => e.text === "Kupující")).toBeTruthy();
  });

  it("redacted output contains no raw PII", () => {
    expect(redacted).not.toContain("tomas.prochazka@email.cz");
    expect(redacted).not.toContain("dvorakova@abcdev.cz");
    expect(redacted).not.toContain("780315/1234");
  });

  it("redacted output preserves structure", () => {
    expect(redacted).toContain("KUPNÍ SMLOUVA");
    expect(redacted).toContain("Článek I.");
    expect(redacted).toContain("Předmět smlouvy");
  });

  it("redacted output uses stable placeholders", () => {
    const personPlaceholders = redacted.match(/\[PERSON_\d+\]/g);
    expect(personPlaceholders).not.toBeNull();
    expect(personPlaceholders?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("pipeline integration: German lease agreement", () => {
  const text = readFixture("german-lease-agreement.txt");
  const { entities, redacted } = runOfflinePipeline(text);

  it("detects titled persons", () => {
    const persons = entities.filter((e) => e.label === "person");
    const texts = persons.map((e) => e.text);
    expect(texts.some((t) => t.includes("Heinrich Schäfer"))).toBeTruthy();
  });

  it("detects address after wohnhaft in", () => {
    const addresses = entities.filter((e) => e.label === "address");
    expect(addresses.some((e) => e.text.includes("Mozartstraße"))).toBeTruthy();
  });

  it("detects Steuernummer", () => {
    expect(
      entities.some((e) => e.label === "tax identification number"),
    ).toBeTruthy();
  });

  it("detects Handelsregister number", () => {
    expect(
      entities.some(
        (e) => e.label === "registration number" && e.text.includes("HRB"),
      ),
    ).toBeTruthy();
  });

  it("detects IBAN", () => {
    expect(entities.some((e) => e.label === "iban")).toBeTruthy();
  });

  it("detects emails", () => {
    const emails = entities
      .filter((e) => e.label === "email address")
      .map((e) => e.text);
    expect(emails).toContain("h.schaefer@praxis-muenchen.de");
    expect(emails).toContain("a.bauer@mueller-partner.de");
  });

  it("extracts der Vermieter as coreference", () => {
    const coref = entities.filter(
      (e) => e.source === DETECTION_SOURCES.COREFERENCE,
    );
    expect(coref.some((e) => e.text === "der Vermieter")).toBeTruthy();
  });

  it("extracts der Mieter as coreference", () => {
    const coref = entities.filter(
      (e) => e.source === DETECTION_SOURCES.COREFERENCE,
    );
    expect(coref.some((e) => e.text === "der Mieter")).toBeTruthy();
  });

  it("redacted output contains no raw PII", () => {
    expect(redacted).not.toContain("h.schaefer@praxis-muenchen.de");
    expect(redacted).not.toContain("143/241/12345");
  });
});

// ── Edge cases ───────────────────────────────────────

describe("pipeline edge cases", () => {
  it("handles empty input", () => {
    const { entities } = runOfflinePipeline("");
    expect(entities).toHaveLength(0);
  });

  it("handles text with no PII", () => {
    const { entities, redacted } = runOfflinePipeline(
      "Dnes je hezké počasí. Slunce svítí.",
    );
    expect(entities).toHaveLength(0);
    expect(redacted).toBe("Dnes je hezké počasí. Slunce svítí.");
  });

  it("does not redact generic roles", () => {
    const { redacted } = runOfflinePipeline(
      "Prodávající a Kupující se dohodli.",
    );
    expect(redacted).not.toContain("[PERSON");
  });

  it("handles overlapping regex and trigger on same span", () => {
    const text = "r.č.: 780315/1234";
    const { entities } = runOfflinePipeline(text);
    const atSpan = entities.filter(
      (e) => e.text === "780315/1234" || e.text.includes("780315"),
    );
    expect(atSpan.length).toBeGreaterThanOrEqual(1);
  });
});
