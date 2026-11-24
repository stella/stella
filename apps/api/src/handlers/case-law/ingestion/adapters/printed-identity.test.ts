/**
 * What an adapter emits as a decision's references is what its publisher
 * prints, never a lookup key derived from it.
 *
 * The pipeline keys every reference for lookup (`citation_key`,
 * `normalized_value`) beside the printed value it stores. An adapter that
 * hands over a key instead (lowercased, separators folded) makes the key the
 * displayed docket: a reader is shown a spelling the publisher never printed,
 * and nothing downstream can recover the printed one. Every lookup key folds
 * letter case, so the sign is a reference whose letters are all lowercase
 * though the publisher's own payload never spells it so.
 *
 * Driven from the registry: every adapter's conformance fixture.
 */
import { describe, expect, test } from "bun:test";

import {
  decodeSourceRawEnvelope,
  toPlainTextIngestionResult,
} from "@/api/lib/legal-search/ingestion-types";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { CASE_LAW_CONFORMANCE_FIXTURES } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

const testFetchState = createTestFetch();

/** Has a letter whose upper case differs, and none written in upper case. */
const foldedToLowercase = (value: string): boolean =>
  value !== value.toLocaleUpperCase("und") &&
  value === value.toLocaleLowerCase("und");

/** Every text the publisher served for the decision, as stored. */
const publisherText = (decision: IngestionResult): string => {
  const raw = decision.sourceRaw ?? "";
  const parts = decodeSourceRawEnvelope(raw);
  return [
    raw,
    ...(parts === null ? [] : Object.values(parts)),
    decision.fulltext ?? "",
  ].join("\n");
};

/** The references a decision displays or is looked up by. */
const referencesOf = (decision: IngestionResult) => [
  { field: "caseNumber", value: decision.caseNumber },
  ...(decision.identifiers ?? []).map(({ type, value }) => ({
    field: `identifiers[${type}]`,
    value,
  })),
];

describe("references are emitted as printed", () => {
  for (const [key, fixture] of Object.entries(CASE_LAW_CONFORMANCE_FIXTURES)) {
    test(key, async () => {
      try {
        const decision = plainTextIngestionResult(
          await fixture().buildDecision(),
        );
        const text = publisherText(decision);
        expect(
          referencesOf(decision).filter(
            ({ value }) => foldedToLowercase(value) && !text.includes(value),
          ),
        ).toEqual([]);
      } finally {
        testFetchState.restore();
      }
    });
  }
});

describe("decision types are labels", () => {
  test("a codelist address is refused as a decision type, and a printed label kept", async () => {
    try {
      const built =
        await CASE_LAW_CONFORMANCE_FIXTURES["cz-uohs"]().buildDecision();
      const label = toPlainTextIngestionResult({
        ...built,
        decisionType: "rozhodnutí",
      });
      expect(label.isOk() && label.value.decisionType === "rozhodnutí").toBe(
        true,
      );
      const address = toPlainTextIngestionResult({
        ...built,
        decisionType:
          "https://uohs.gov.cz/cs/ciselniky/typy-rozhodnuti/160.html",
      });
      expect(address.isErr() ? address.error.reason : undefined).toBe(
        "address-as-label",
      );
    } finally {
      testFetchState.restore();
    }
  });
});
