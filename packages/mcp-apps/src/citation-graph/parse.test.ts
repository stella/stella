import { describe, expect, test } from "bun:test";

import { DECISION_TEXT_WITHHELD_REASON } from "@stll/api-contract/case-law-text-field";

import { GRAPH_TEST_CITATION_TREATMENTS } from "./citation-treatments.test-support";
import { parseCitationPage } from "./parse";
import type { CitationPage } from "./parse";

const validCitation = {
  citationId: "synthetic-citation",
  citationText: "Synthetic citation text",
  textWithheldReason: null,
  polarity: "unclassified",
  doctrine: null,
  decision: null,
  passage: null,
} satisfies CitationPage["citations"][number];

const validPage = {
  doctrineAvailability: "unavailable",
  decisionId: "synthetic-subject",
  direction: "cites",
  nextCursor: null,
  citations: [validCitation],
} satisfies CitationPage;

describe("citation page parsing", () => {
  test("preserves the applied doctrine and polarity filters", () => {
    const payload = {
      ...validPage,
      doctrine: "limits",
      polarity: "negative",
    } satisfies CitationPage;

    expect(parseCitationPage(payload)).toEqual(payload);
  });

  test("accepts resolved docket decisions with the default identifier type omitted", () => {
    const payload = {
      ...validPage,
      citations: [
        {
          ...validCitation,
          decision: {
            url: "https://example.org/decision",
            caseNumber: "Synthetic docket",
            citationAuthority: 1,
            court: "Synthetic court",
            decisionDate: null,
            decisionId: "synthetic-target",
            decisionType: null,
            resourceName: "case-law/synthetic-target",
          },
        },
      ],
    } satisfies CitationPage;
    expect(parseCitationPage(payload)).toEqual(payload);
  });

  test("accepts the public citation shape and preserves withheld markers", () => {
    const payload = {
      ...validPage,
      citations: [
        {
          ...validCitation,
          citationText: "Synthetic text supplied with a withholding marker",
          textWithheldReason: DECISION_TEXT_WITHHELD_REASON.SOURCE_LICENCE,
          passage: {
            anchorId: "synthetic-anchor",
            text: "Synthetic excerpt supplied with a withholding marker",
            truncated: false,
            mention: "sole",
          },
        },
      ],
    } satisfies CitationPage;

    expect(parseCitationPage(payload)).toEqual(payload);
  });

  test("accepts every declared polarity, including unclassified", () => {
    for (const polarity of GRAPH_TEST_CITATION_TREATMENTS) {
      expect(
        parseCitationPage({
          ...validPage,
          citations: [{ ...validCitation, polarity }],
        })?.citations.at(0)?.polarity,
      ).toBe(polarity);
    }
  });

  test("rejects values outside the closed contract", () => {
    for (const payload of [
      {
        ...validPage,
        citations: [{ ...validCitation, polarity: "not-a-treatment" }],
      },
      {
        ...validPage,
        citations: [{ ...validCitation, extra: "not in the contract" }],
      },
      { ...validPage, direction: "incoming" },
    ]) {
      expect(parseCitationPage(payload)).toBeUndefined();
    }
  });
});
