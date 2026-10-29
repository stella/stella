import { describe, expect, expectTypeOf, test } from "bun:test";

import {
  isKeyableListingIdentity,
  isPersistableSourceDocumentId,
} from "@/api/lib/legal-search/ingestion-types";
import {
  isQuarantineListingIdentity,
  isQuarantineSourceDocumentId,
  LEGACY_REPAIR_NAMESPACE,
  LISTING_OBSERVATION_REASON,
  QUARANTINE_NAMESPACE,
  quarantinedListingObservation,
  quarantineIdentity,
  quarantineSourceDocumentId,
  type RepairAlias,
  repairAliasesForStableFields,
} from "@/api/lib/legal-search/quarantine-identity";

describe("repair alias qualification", () => {
  test.each(Object.values(QUARANTINE_NAMESPACE))(
    "%s keeps metadata-only observations out of adoption",
    (namespace) => {
      const identity = quarantineIdentity({
        namespace,
        stableFields: {
          court: "Published court",
          decisionDate: "2026-01-12",
          author: "Published author",
          subject: "Published subject",
          keywords: "contract",
          statutes: "Section 12",
        },
      });
      expect(identity.sourceDocumentId.length).toBeGreaterThan(0);
      expect(identity.repairAliases).toEqual([]);
    },
  );

  test("only the discriminator stated by that fingerprint qualifies it", () => {
    const shared = {
      court: "Published court",
      decisionDate: "2026-01-12",
      subject: "Published subject",
    };
    const first = quarantineIdentity({
      namespace: QUARANTINE_NAMESPACE.CZ_REGIONAL,
      stableFields: { docket: "18 C 130/2024", ...shared },
    });
    const second = quarantineIdentity({
      namespace: QUARANTINE_NAMESPACE.CZ_REGIONAL,
      stableFields: { docket: "18 C 131/2024", ...shared },
    });
    const absent = quarantineIdentity({
      namespace: QUARANTINE_NAMESPACE.CZ_REGIONAL,
      stableFields: { docket: undefined, ...shared },
    });
    expect(first.repairAliases).toEqual([first.sourceDocumentId]);
    expect(second.repairAliases).toEqual([second.sourceDocumentId]);
    expect(
      first.repairAliases.filter((alias) =>
        second.repairAliases.includes(alias),
      ),
    ).toEqual([]);
    expect(absent.repairAliases).toEqual([]);
    expectTypeOf<string>().not.toExtend<RepairAlias>();
  });
});

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
      repairAliases: [
        "nalus-quarantine:43ae4610609797ebfc941ed3d3ebc641fa2d31fd1a73cdfd19c5754a069860f8",
      ],
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

describe("noncanonical listing observations", () => {
  test("content addressing is stable across JSON object order and separated by source", () => {
    const payload = { note: "Listed record", malformedId: null };
    const first = quarantinedListingObservation({
      source: QUARANTINE_NAMESPACE.SK_US,
      payload,
      reason: LISTING_OBSERVATION_REASON.NO_USABLE_ID,
    });
    const reordered = quarantinedListingObservation({
      source: QUARANTINE_NAMESPACE.SK_US,
      payload: { malformedId: null, note: "Listed record" },
      reason: LISTING_OBSERVATION_REASON.NO_USABLE_ID,
    });
    const otherSource = quarantinedListingObservation({
      source: QUARANTINE_NAMESPACE.PL_COURTS,
      payload,
      reason: LISTING_OBSERVATION_REASON.NO_USABLE_ID,
    });
    expect(first.identity).toEqual(reordered.identity);
    expect(first.identity.fingerprint).not.toBe(
      otherSource.identity.fingerprint,
    );
    expect(first.payload).toBe(payload);
    expectTypeOf(first.identity).not.toExtend<string>();
    expect(first.identity).not.toHaveProperty("sourceDocumentId");
  });

  test("different exposed values remain distinct observations", () => {
    const identity = (payload: unknown) =>
      quarantinedListingObservation({
        source: QUARANTINE_NAMESPACE.SK_US,
        payload,
        reason: LISTING_OBSERVATION_REASON.NO_USABLE_ID,
      }).identity;
    expect(identity(null)).not.toEqual(identity({}));
    expect(identity({ text: "A" })).not.toEqual(identity({ text: "B" }));
  });
});

describe("court provenance of repair forms", () => {
  test.each([
    {
      form: "CZ regional docket without court",
      namespace: QUARANTINE_NAMESPACE.CZ_REGIONAL,
      fields: { docket: "18 C 130/2024" },
      courtField: "court",
    },
    {
      form: "SK courts with both court fields absent",
      namespace: QUARANTINE_NAMESPACE.SK_COURTS,
      fields: { spisovaZnacka: "1 C 12/2024" },
      courtField: "sud",
    },
    {
      form: "HU docket without court",
      namespace: QUARANTINE_NAMESPACE.HU_BHGY,
      fields: { docket: "Pfv.20.123/2024" },
      courtField: "court",
    },
    {
      form: "KIO signature without court",
      namespace: LEGACY_REPAIR_NAMESPACE.PL_KIO,
      fields: { signature: "KIO 12/24" },
      courtField: "court",
    },
    {
      form: "NSA docket without court",
      namespace: LEGACY_REPAIR_NAMESPACE.PL_NSA,
      fields: { docket_number: "II SA 12/24" },
      courtField: "court_name",
    },
    {
      form: "NSS reference without court",
      namespace: QUARANTINE_NAMESPACE.CZ_NSS,
      fields: { reference: "1 As 12/2024-10" },
      courtField: "court",
    },
    {
      form: "national court listed signature without court",
      namespace: LEGACY_REPAIR_NAMESPACE.PL_NCOURT_LISTED,
      fields: { signature: "II Ca 236/18" },
      courtField: "courtId",
    },
  ])(
    "$form stays stored but cannot adopt another row",
    ({ namespace, fields, courtField }) => {
      const sourceDocumentIds = ["captured-quarantine-row"];
      expect(
        repairAliasesForStableFields({
          namespace,
          sourceDocumentIds,
          stableFields: fields,
        }),
      ).toEqual([]);
      expect(
        repairAliasesForStableFields({
          namespace,
          sourceDocumentIds,
          stableFields: { ...fields, [courtField]: "Published court" },
        }),
      ).toEqual(sourceDocumentIds);
    },
  );

  test("national court thesis/date form stays stored without becoming a repair alias", () => {
    const identity = quarantineIdentity({
      namespace: QUARANTINE_NAMESPACE.PL_NCOURT,
      stableFields: {
        publicationDate: "2024-01-04",
        thesis: "Published thesis",
      },
    });
    expect(identity.sourceDocumentId).toStartWith("pl-ncourt-quarantine:");
    expect(identity.repairAliases).toEqual([]);
  });

  test("court category and division do not qualify a historical PL courts fingerprint", () => {
    const identity = quarantineIdentity({
      namespace: QUARANTINE_NAMESPACE.PL_COURTS,
      stableFields: {
        docket: "II Ca 236/18",
        courtType: "COMMON",
        divisionId: "12",
      },
    });
    expect(identity.sourceDocumentId).toStartWith("pl-courts-quarantine:");
    expect(identity.repairAliases).toEqual([]);
  });
});
