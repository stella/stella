import { describe, expect, test } from "bun:test";

import {
  isKeyableListingIdentity,
  isPersistableSourceDocumentId,
} from "@/api/lib/legal-search/ingestion-types";
import {
  isQuarantineListingIdentity,
  isQuarantineSourceDocumentId,
  QUARANTINE_NAMESPACE,
  quarantineIdentity,
  quarantineSourceDocumentId,
} from "@/api/lib/legal-search/quarantine-identity";

describe("quarantineIdentity", () => {
  test("keeps the Constitutional Court's stored quarantine ids byte for byte", () => {
    // Stored NALUS rows carry ids the adapter minted before this module
    // existed; a different digest would orphan each of them and insert its
    // record again under a second id.
    expect(
      quarantineIdentity({
        namespace: QUARANTINE_NAMESPACE.CZ_US,
        stableFields: {
          stablePrimaryText: "  1.   III.ÚS 2045/24 \n Nález ",
          stableActionsText: "Text",
          stableDetailText: "III.ÚS 2045/24",
          stableCounterText: "",
        },
      }),
    ).toEqual({
      fingerprint:
        "43ae4610609797ebfc941ed3d3ebc641fa2d31fd1a73cdfd19c5754a069860f8",
      sourceDocumentId:
        "nalus-quarantine:43ae4610609797ebfc941ed3d3ebc641fa2d31fd1a73cdfd19c5754a069860f8",
    });
  });

  test("a reflowed listing names the same record", () => {
    const fields = (docket: string) =>
      quarantineIdentity({
        namespace: QUARANTINE_NAMESPACE.PL_SN,
        stableFields: { docket, date: "2024-01-04" },
      });
    expect(fields("II  CSK\n 12/24 ")).toEqual(fields("II CSK 12/24"));
  });

  test("an absent field differs from an empty one only by its absence", () => {
    const absent = quarantineIdentity({
      namespace: QUARANTINE_NAMESPACE.PL_SN,
      stableFields: { docket: "II CSK 12/24", date: undefined },
    });
    expect(absent).toEqual(
      quarantineIdentity({
        namespace: QUARANTINE_NAMESPACE.PL_SN,
        stableFields: { docket: "II CSK 12/24" },
      }),
    );
    expect(absent).not.toEqual(
      quarantineIdentity({
        namespace: QUARANTINE_NAMESPACE.PL_SN,
        stableFields: { docket: "II CSK 12/24", date: "" },
      }),
    );
  });

  test("each field value moves the identity", () => {
    const base = { docket: "II CSK 12/24", date: "2024-01-04" };
    const ids = new Set(
      [
        base,
        { ...base, docket: "II CSK 13/24" },
        { ...base, date: "2024-01-05" },
        // A value moved between fields is a different record.
        { docket: "2024-01-04", date: "II CSK 12/24" },
      ].map(
        (stableFields) =>
          quarantineIdentity({
            namespace: QUARANTINE_NAMESPACE.PL_SN,
            stableFields,
          }).sourceDocumentId,
      ),
    );
    expect(ids.size).toBe(4);
  });

  test("every namespace is distinct and mints a keyable, recognisable id", () => {
    const namespaces = Object.values(QUARANTINE_NAMESPACE);
    expect(new Set(namespaces).size).toBe(namespaces.length);
    for (const namespace of namespaces) {
      const { fingerprint, sourceDocumentId } = quarantineIdentity({
        namespace,
        stableFields: { text: "x" },
      });
      const identity = { type: "document", sourceDocumentId } as const;
      expect(sourceDocumentId).toBe(
        quarantineSourceDocumentId(namespace, fingerprint),
      );
      expect(isPersistableSourceDocumentId(sourceDocumentId)).toBe(true);
      expect(isKeyableListingIdentity(identity)).toBe(true);
      expect(isQuarantineSourceDocumentId(namespace, sourceDocumentId)).toBe(
        true,
      );
      expect(isQuarantineListingIdentity(identity)).toBe(true);
    }
  });

  test("legacy national-court listings stay quarantined for reconciliation", () => {
    expect(
      isQuarantineListingIdentity({
        type: "document",
        sourceDocumentId: "ncourt-listed:record-fingerprint",
      }),
    ).toBe(true);
  });

  test("a publisher identity is not a quarantine identity", () => {
    for (const identity of [
      { type: "document", sourceDocumentId: "nalus-record:7201" },
      { type: "document", sourceDocumentId: "quarantine:abc" },
      { type: "case-number", caseNumber: "nalus-quarantine:x", language: "cs" },
    ] as const) {
      expect(isQuarantineListingIdentity(identity)).toBe(false);
    }
  });
});
