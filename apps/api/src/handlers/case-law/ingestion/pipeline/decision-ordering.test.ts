import { describe, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { courtListenerIngestFixture } from "@/api/tests/helpers/case-law-ingest-fixture";

import { decisionOrderingKeys } from "./decision-ordering";
import { sourceContractForAdapter } from "./source-contract";

const sourceId = createSafeId<"caseLawSource">();
const czNs = sourceContractForAdapter("cz-ns");

const czDecision = (
  overrides: Partial<Parameters<typeof plainTextIngestionResult>[0]>,
): IngestionResult =>
  plainTextIngestionResult({
    caseNumber: "21 Cdo 5/2019",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2019-03-01",
    metadata: {},
    rawHash: "hash",
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    fulltext: "Text.",
    documentAst: {},
    ...overrides,
  });

const keysOf = (decision: IngestionResult) =>
  decisionOrderingKeys({ type: "decision", decision }, sourceId, czNs);

const share = (left: readonly string[], right: readonly string[]) =>
  left.some((key) => right.includes(key));

describe("decisionOrderingKeys", () => {
  test("two observations of one publisher identity share a key", () => {
    expect(
      share(
        keysOf(
          czDecision({ sourceDocumentId: "doc-1", caseNumber: "1 A 1/2019" }),
        ),
        keysOf(
          czDecision({ sourceDocumentId: "doc-1", caseNumber: "2 B 2/2020" }),
        ),
      ),
    ).toBe(true);
  });

  test("a publisher alias meets the identity it names", () => {
    expect(
      share(
        keysOf(
          czDecision({ sourceDocumentId: "doc-1", caseNumber: "1 A 1/2019" }),
        ),
        keysOf(
          czDecision({
            sourceDocumentId: "doc-2",
            sourceDocumentIdAliases: ["doc-1"],
            caseNumber: "2 B 2/2020",
          }),
        ),
      ),
    ).toBe(true);
  });

  test("decisions of one docket share a key whatever its spelling", () => {
    expect(
      share(
        keysOf(
          czDecision({
            sourceDocumentId: "doc-1",
            caseNumber: "21 Cdo 5/2019",
          }),
        ),
        keysOf(
          czDecision({
            sourceDocumentId: "doc-2",
            caseNumber: "21 CDO 5 / 2019",
          }),
        ),
      ),
    ).toBe(true);
  });

  test("decisions without a publisher id meet on their docket", () => {
    expect(
      share(
        keysOf(czDecision({ caseNumber: "21 Cdo 5/2019", fulltext: "One." })),
        keysOf(czDecision({ caseNumber: "21 Cdo 5/2019", fulltext: "Two." })),
      ),
    ).toBe(true);
  });

  test("one ECLI meets itself across identities and dockets", () => {
    expect(
      share(
        keysOf(
          czDecision({
            sourceDocumentId: "doc-1",
            caseNumber: "1 A 1/2019",
            ecli: "ECLI:CZ:NS:2019:21.CDO.5.2019.1",
          }),
        ),
        keysOf(
          czDecision({
            sourceDocumentId: "doc-2",
            caseNumber: "2 B 2/2020",
            ecli: "ECLI:CZ:NS:2019:21.CDO.5.2019.1",
          }),
        ),
      ),
    ).toBe(true);
  });

  test("decisions of different identities and dockets share nothing", () => {
    expect(
      share(
        keysOf(
          czDecision({ sourceDocumentId: "doc-1", caseNumber: "1 A 1/2019" }),
        ),
        keysOf(
          czDecision({ sourceDocumentId: "doc-2", caseNumber: "2 B 2/2020" }),
        ),
      ),
    ).toBe(false);
  });

  test("a record the observation refuses still carries its stated keys", () => {
    const refused = czDecision({
      sourceDocumentId: "doc-1",
      court: "A court the directory does not know",
      country: "USA",
    });
    expect(keysOf(refused).length).toBeGreaterThan(0);
    expect(
      share(keysOf(refused), keysOf(czDecision({ sourceDocumentId: "doc-1" }))),
    ).toBe(true);
  });

  test("a source rejection has no keys", () => {
    expect(
      decisionOrderingKeys(
        {
          type: "rejected",
          recordKey: "k",
          recordHash: "h",
          reason: "unmappable",
          message: "m",
          language: "cs",
        },
        sourceId,
        czNs,
      ),
    ).toEqual([]);
  });

  test("the measured stream keys its repeated dockets and revisions together", () => {
    const stream = courtListenerIngestFixture({ count: 300, namespace: 7003 });
    const contract = sourceContractForAdapter("us-courtlistener");
    const keys = stream.map((decision) =>
      decisionOrderingKeys({ type: "decision", decision }, sourceId, contract),
    );
    // Record 40 repeats record 39's citation; record 290 revises record 90.
    expect(share(keys[40] ?? [], keys[39] ?? [])).toBe(true);
    expect(share(keys[290] ?? [], keys[90] ?? [])).toBe(true);
    expect(share(keys[10] ?? [], keys[11] ?? [])).toBe(false);
  });
});
