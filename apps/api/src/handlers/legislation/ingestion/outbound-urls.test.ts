import { expect, test } from "bun:test";

import {
  LEGISLATION_URL_FIELDS,
  restrictLegislationDocumentUrls,
} from "@/api/handlers/legislation/ingestion/outbound-urls";
import type {
  LegislationUrlBearingField,
  LegislationUrlField,
  UrlRefusalReason,
} from "@/api/handlers/legislation/ingestion/outbound-urls";
import { createSafeId } from "@/api/lib/branded-types";
import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";
import type { OutboundHostPolicy } from "@/api/lib/restrict-outbound-url";

const sourceId = createSafeId<"legislationSource">();

const hostPolicy: OutboundHostPolicy = {
  type: "exact-origin",
  origins: ["https://legislation.example.gov"],
};

const document = (
  urls: Partial<Record<LegislationUrlField, string>>,
): LegislationDocumentInput => ({
  sourceId,
  eli: "SVK/act/1",
  title: "An act",
  country: "SVK",
  language: "sk",
  rawHash: "f".repeat(64),
  ...urls,
});

type Assert<TCondition extends true> = TCondition;

/**
 * True while every `…Url` field the document input carries is one the guard
 * checks. A new URL field that nobody adds to `LEGISLATION_URL_FIELDS` makes
 * this `false`, and the assignment below stops compiling — a URL the guard
 * skips is a URL that reaches storage unchecked.
 */
type EveryUrlFieldIsChecked = Assert<
  [Exclude<LegislationUrlBearingField, LegislationUrlField>] extends [never]
    ? true
    : false
>;

test("every URL-bearing field of the document input is checked", () => {
  const everyUrlFieldIsChecked: EveryUrlFieldIsChecked = true;
  expect(everyUrlFieldIsChecked).toBe(true);
  expect([...LEGISLATION_URL_FIELDS].sort()).toEqual([
    "documentUrl",
    "sourceUrl",
  ]);
});

test("URLs on the declared origin pass through in their validated form", () => {
  const outcome = restrictLegislationDocumentUrls({
    document: document({
      sourceUrl: "https://legislation.example.gov/act/1",
      documentUrl: "https://legislation.example.gov/act/1/text",
    }),
    hostPolicy,
  });
  expect(outcome.refusals).toEqual([]);
  expect(outcome.document.sourceUrl).toBe(
    "https://legislation.example.gov/act/1",
  );
  expect(outcome.document.documentUrl).toBe(
    "https://legislation.example.gov/act/1/text",
  );
});

/** Refused URL, the host the log may carry, and the reason it is filed under. */
const REFUSAL_CASES = [
  ["http://169.254.169.254/latest/meta-data/", "169.254.169.254", "policy"],
  [
    "https://legislation.example.gov.attacker.test/act/1",
    "legislation.example.gov.attacker.test",
    "policy",
  ],
  ["http://legislation.example.gov/act/1", "legislation.example.gov", "policy"],
  ["file:///etc/passwd", "none", "policy"],
  [
    "https://user:pass@legislation.example.gov/act/1",
    "legislation.example.gov",
    "credentials",
  ],
  [
    "https://legislation.example.gov/act/1#paragraf-1",
    "legislation.example.gov",
    "fragment",
  ],
  ["not a url at all", "unparseable", "unparseable"],
] as const satisfies readonly (readonly [string, string, UrlRefusalReason])[];

test.each(REFUSAL_CASES)(
  "the document URL %p is nulled and reported redacted",
  (documentUrl, host, reason) => {
    const outcome = restrictLegislationDocumentUrls({
      document: document({ documentUrl }),
      hostPolicy,
    });
    // The refused value never reaches the caller, so it cannot reach a log.
    expect(outcome.refusals).toEqual([{ field: "documentUrl", host, reason }]);
    expect(JSON.stringify(outcome.refusals)).not.toContain(documentUrl);
    expect(outcome.document.documentUrl).toBeNull();
  },
);

test("one refused field leaves the others and the document intact", () => {
  const input = document({
    sourceUrl: "https://legislation.example.gov/act/1",
    documentUrl: "http://169.254.169.254/latest/meta-data/",
  });
  const outcome = restrictLegislationDocumentUrls({
    document: input,
    hostPolicy,
  });
  expect(outcome.refusals).toHaveLength(1);
  expect(outcome.document).toEqual({
    ...input,
    sourceUrl: "https://legislation.example.gov/act/1",
    documentUrl: null,
  });
});

test("a document carrying no URL at all is unchanged", () => {
  const input = document({});
  const outcome = restrictLegislationDocumentUrls({
    document: input,
    hostPolicy,
  });
  expect(outcome).toEqual({ document: input, refusals: [] });
});
