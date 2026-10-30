import { describe, expect, test } from "bun:test";

import { filterQuarantinePeerCollisions } from "@/api/handlers/case-law/ingestion/quarantine-collision-filter";
import {
  listReconciliationSlice,
  SLICE_LISTING_PROOF,
} from "@/api/handlers/case-law/ingestion/slice-listing";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import {
  LEGACY_REPAIR_NAMESPACE,
  repairAliasesForStableFields,
} from "@/api/lib/legal-search/quarantine-identity";
import { LEGACY_QUARANTINE_PREFIXES } from "@/api/lib/legal-search/quarantine-prefixes";

describe("quarantine collision filtering", () => {
  test("a legacy quarantine peer remains separate in complete-scope filtering", async () => {
    const sourceDocumentId = `${LEGACY_QUARANTINE_PREFIXES.ris}${"a".repeat(64)}`;
    const aliases = repairAliasesForStableFields({
      namespace: LEGACY_REPAIR_NAMESPACE.AT_COURTS,
      sourceDocumentIds: [sourceDocumentId],
      stableFields: { caseNumbers: "21 Cdo 12/2024", court: "Published court" },
    });
    const decision = plainTextIngestionResult({
      caseNumber: "21 Cdo 12/2024",
      sourceDocumentId: "publisher-record",
      sourceDocumentIdRepairAliases: aliases,
      court: "Nejvyšší soud",
      country: "CZE",
      language: "cs",
      fulltext: "Published decision text.",
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      metadata: {},
      rawHash: "b".repeat(64),
      documentAst: EMPTY_AST,
    });
    expect(decision.sourceDocumentId).toBe("publisher-record");
    const listing = (
      await listReconciliationSlice({
        adapterKey: "fixture",
        proof: SLICE_LISTING_PROOF.IDENTITIES,
        revisionOf: (payload) => payload,
        persistEvidence: async () => undefined,
        listSlicePage: async () =>
          await Promise.resolve({
            observations: [],
            items: [sourceDocumentId, "publisher-record"].map((id) => ({
              identity: { type: "document" as const, sourceDocumentId: id },
              payload: { id },
            })),
            totalPages: 1,
          }),
        slice: "all",
        pageDelayMs: 0,
        pageTimeoutMs: 5000,
        sleep: async () => {
          await Promise.resolve();
        },
      })
    ).unwrap("A complete listing certifies its scope");
    const filtered = filterQuarantinePeerCollisions({
      decisions: [decision],
      proof: listing.recoveryProof,
    });
    expect(filtered.collidingIds).toEqual([sourceDocumentId]);
    expect(filtered.decisions.at(0)?.sourceDocumentIdRepairAliases).toEqual([]);
    expect(decision.sourceDocumentIdRepairAliases?.map(String)).toEqual([
      sourceDocumentId,
    ]);
  });
});
