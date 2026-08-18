import { expect, test } from "bun:test";

import {
  LEGISLATION_URL_FIELDS,
  restrictLegislationDocumentUrls,
} from "@/api/handlers/legislation/ingestion/outbound-urls";
import type {
  LegislationUrlBearingField,
  LegislationUrlField,
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
  expect(outcome.type).toBe("allowed");
  if (outcome.type !== "allowed") {
    return;
  }
  expect(outcome.document.sourceUrl).toBe(
    "https://legislation.example.gov/act/1",
  );
  expect(outcome.document.documentUrl).toBe(
    "https://legislation.example.gov/act/1/text",
  );
});

test.each([
  ["http://169.254.169.254/latest/meta-data/"],
  ["https://legislation.example.gov.attacker.test/act/1"],
  ["http://legislation.example.gov/act/1"],
  ["file:///etc/passwd"],
  ["https://user:pass@legislation.example.gov/act/1"],
])("a document URL at %s is refused", (documentUrl) => {
  const outcome = restrictLegislationDocumentUrls({
    document: document({ documentUrl }),
    hostPolicy,
  });
  expect(outcome).toEqual({
    type: "refused",
    field: "documentUrl",
    rawUrl: documentUrl,
  });
});

test("a document carrying no URL at all is allowed unchanged", () => {
  const input = document({});
  const outcome = restrictLegislationDocumentUrls({
    document: input,
    hostPolicy,
  });
  expect(outcome).toEqual({ type: "allowed", document: input });
});
