import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { DECISION_DOCUMENT_ROLE } from "@stll/api-contract/decision-document-role";

import { SOURCE_RAW_ENVELOPE_CONTENT_TYPE } from "@/api/handlers/case-law/ingestion/adapter";
import type { StoredRawReparseInput } from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildPlItem,
  normalizeSaosDumpItem,
  PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
  plCourtsAdapter,
  SAOS_JUDGMENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";

const CASE_NUMBER = "I ACa 1/24";
const publisherRow = (judgmentType: string | null | undefined) => ({
  id: 42,
  judgmentType,
  judgmentDate: "2024-01-02",
  courtCases: [{ caseNumber: CASE_NUMBER }],
  division: { id: 1, name: "Civil", court: { name: "Court" } },
  textContent: "UZASADNIENIE\nWritten reasons in the publisher's text",
});

const buildDocument = (
  listing: ReturnType<typeof publisherRow>,
  detail: ReturnType<typeof publisherRow> | null = null,
) => {
  const item =
    buildPlItem({
      listingItem: normalizeSaosDumpItem(listing),
      detail: detail === null ? null : normalizeSaosDumpItem(detail),
      rawParts: { "listing-dump": JSON.stringify(listing) },
    }) ?? panic("the SAOS role fixture built nothing");
  return item.type === "decision" ? item.decision : item.supplement.document;
};

const reparse =
  plCourtsAdapter.reparseStoredRaw ??
  panic("pl-courts declares no reparseStoredRaw");

const storedInput = ({
  listing,
  detail,
  envelope,
}: {
  listing: ReturnType<typeof publisherRow>;
  detail: ReturnType<typeof publisherRow> | null;
  envelope: boolean;
}): StoredRawReparseInput => ({
  raw: new TextEncoder().encode(
    JSON.stringify(
      envelope
        ? {
            version: 1,
            parts: {
              "listing-dump": JSON.stringify(listing),
              ...(detail === null
                ? {}
                : { detail: JSON.stringify({ data: detail }) }),
            },
          }
        : { dumpItem: listing, detail },
    ),
  ),
  contentType: envelope ? SOURCE_RAW_ENVELOPE_CONTENT_TYPE : "application/json",
  caseNumber: CASE_NUMBER,
  sourceDocumentId: "42",
  language: "pl",
  court: "Court",
  ecli: null,
  decisionDate: "2024-01-02",
  // A localized legacy label is deliberately insufficient to classify role.
  decisionType: "uzasadnienie",
  sourceUrl: null,
  documentUrl: null,
  metadata: {},
});

const reparsedDocument = async (input: StoredRawReparseInput) => {
  const outcome = await reparse(input);
  switch (outcome.type) {
    case "parsed":
      return outcome.result;
    case "supplement":
      return outcome.supplement.document;
    case "rejected":
      return panic(`SAOS role fixture rejected: ${outcome.detail}`);
    default:
      outcome satisfies never;
      return panic("unhandled SAOS role fixture outcome");
  }
};

describe("SAOS publisher document roles", () => {
  const cases = [
    { value: "SENTENCE", role: DECISION_DOCUMENT_ROLE.RULING, type: "wyrok" },
    {
      value: "DECISION",
      role: DECISION_DOCUMENT_ROLE.RULING,
      type: "postanowienie",
    },
    {
      value: "RESOLUTION",
      role: DECISION_DOCUMENT_ROLE.RULING,
      type: "uchwała",
    },
    {
      value: "REGULATION",
      role: DECISION_DOCUMENT_ROLE.RULING,
      type: "zarządzenie",
    },
    {
      value: "REASONS",
      role: DECISION_DOCUMENT_ROLE.REASONS,
      type: PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
    },
  ];

  test("the replay matrix covers every declared publisher enum", () => {
    expect(cases.map(({ value }) => value).toSorted()).toEqual(
      Object.keys(SAOS_JUDGMENT_TYPE).toSorted(),
    );
  });

  for (const { value, role, type } of cases) {
    test(`${value} survives old and current raw replay without changing the stated type`, async () => {
      const listing = publisherRow(value);
      const built = buildDocument(listing);
      expect(built.documentRole).toBe(role);
      expect(built.decisionType === type).toBe(true);
      expect(built.metadata["decisionType"] === type).toBe(true);

      for (const envelope of [false, true]) {
        const input = storedInput({ listing, detail: null, envelope });
        const parsed = await reparsedDocument(input);
        expect(parsed.documentRole).toBe(role);
        expect(parsed.decisionType === type).toBe(true);
        expect(parsed.metadata["decisionType"] === type).toBe(true);
        expect(await reparsedDocument(input)).toEqual(parsed);
        if (parsed.sourceRaw === undefined) {
          panic("SAOS replay did not preserve its raw envelope");
        }
        const replayed = await reparsedDocument({
          ...input,
          raw: new TextEncoder().encode(parsed.sourceRaw),
          contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
          metadata: parsed.metadata,
        });
        expect(replayed).toEqual(parsed);
      }
    });
  }

  test("detail enums take precedence, and missing detail enums fall back to the listing", async () => {
    const listing = publisherRow("SENTENCE");
    for (const envelope of [false, true]) {
      const reasons = await reparsedDocument(
        storedInput({ listing, detail: publisherRow("REASONS"), envelope }),
      );
      expect(reasons.documentRole).toBe(DECISION_DOCUMENT_ROLE.REASONS);
      expect(
        reasons.decisionType === PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
      ).toBe(true);

      const ruling = await reparsedDocument(
        storedInput({ listing, detail: publisherRow(null), envelope }),
      );
      expect(ruling.documentRole).toBe(DECISION_DOCUMENT_ROLE.RULING);
      expect(ruling.decisionType === "wyrok").toBe(true);
    }
  });

  test("missing, unknown and localized values stay unknown despite reasons prose and legacy labels", async () => {
    for (const value of [undefined, null, "FUTURE_VALUE", "uzasadnienie"]) {
      const listing = publisherRow(value);
      expect(buildDocument(listing).documentRole).toBeUndefined();
      for (const envelope of [false, true]) {
        const parsed = await reparsedDocument(
          storedInput({ listing, detail: null, envelope }),
        );
        expect(parsed.documentRole).toBeUndefined();
        expect(parsed.decisionType).toBe(buildDocument(listing).decisionType);
      }
    }
  });
});
