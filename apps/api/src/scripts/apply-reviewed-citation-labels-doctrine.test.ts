import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import { CITATION_REVIEW_ORIGIN } from "@/api/handlers/case-law/polarity/consts";
import { DOCTRINAL_TREATMENTS } from "@/api/lib/case-law/doctrine";
import { reviewedCitationDoctrineEntrySchema } from "@/api/scripts/apply-reviewed-citation-labels-doctrine";

const entry = {
  kind: "doctrine",
  citationId: "019a48a1-82d0-7a6f-bd47-3daa963125a1",
  reviewRef: "doctrine-reading",
  origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
  passage: "The earlier decision does not apply to these different facts.",
} as const;

const validReading = {
  ...entry,
  doctrinalTreatment: "distinguishes",
  evidenceQuote: "does not apply to these different facts",
};

describe("reviewed doctrinal entry boundary", () => {
  test.each(DOCTRINAL_TREATMENTS)(
    "accepts the canonical treatment %s",
    (doctrinalTreatment) => {
      expect(
        v.safeParse(reviewedCitationDoctrineEntrySchema, {
          ...entry,
          doctrinalTreatment,
          ...(doctrinalTreatment === "not_stated"
            ? {}
            : { evidenceQuote: "does not apply" }),
        }).success,
      ).toBe(true);
    },
  );

  test("rejects absent, blank, paraphrased and foreign quotes on either substantive label", () => {
    for (const doctrinalTreatment of DOCTRINAL_TREATMENTS.filter(
      (value) => value !== "not_stated",
    )) {
      for (const evidenceQuote of [
        undefined,
        null,
        "",
        " ",
        "does NOT apply",
        "different legal issue",
        "\u0000",
      ]) {
        expect(
          v.safeParse(reviewedCitationDoctrineEntrySchema, {
            ...entry,
            doctrinalTreatment,
            evidenceQuote,
          }).success,
        ).toBe(false);
      }
    }
    expect(
      v.safeParse(reviewedCitationDoctrineEntrySchema, validReading).success,
    ).toBe(true);
  });

  test("model provenance hashes the exact passage, including spacing", () => {
    const adjudication = {
      ...validReading,
      origin: CITATION_REVIEW_ORIGIN.AI_ADJUDICATED,
      model: "doctrine-reader",
      promptVersion: "doctrine-v1",
      promptSha256: "a".repeat(64),
      evidenceSha256: sha256Hex(entry.passage),
      textRevisionSha256: "b".repeat(64),
      runId: "doctrine-run",
      producedAt: "2026-10-07T08:00:00Z",
    };
    expect(
      v.safeParse(reviewedCitationDoctrineEntrySchema, adjudication).success,
    ).toBe(true);
    expect(
      v.safeParse(reviewedCitationDoctrineEntrySchema, {
        ...adjudication,
        passage: `${entry.passage} `,
      }).success,
    ).toBe(false);
  });
});
