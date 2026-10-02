import { describe, expect, test } from "bun:test";

import { listAdapters } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  czUsAdapter,
  type ListedDecision,
} from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import { plNcourtAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt";
import { plNsaAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa";
import { plUokikAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-uokik";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

const risIdentityPayloads = ["JUT_20260101_1", "JUT_20260101_2"].map((id) => ({
  Data: { Metadaten: { Technisch: { ID: id } } },
}));

// Minimal publisher identity signals; traversal fields are exercised separately below.
// Total over the registry, including adapters sharing the RIS implementation.
const IDENTITY_REVISION_PAYLOADS = {
  [ADAPTER_KEYS.CZ_NS]: [
    { unid: "00000000000000000000000000000001" },
    { unid: "00000000000000000000000000000002" },
  ],
  [ADAPTER_KEYS.CZ_NSS]: [{ documentId: "1" }, { documentId: "2" }],
  [ADAPTER_KEYS.CZ_US]: [{ sourceDocumentId: "1" }, { sourceDocumentId: "2" }],
  [ADAPTER_KEYS.CZ_REGIONAL]: [
    { odkaz: "https://rozhodnuti.justice.cz/doc/1" },
    { odkaz: "https://rozhodnuti.justice.cz/doc/2" },
  ],
  [ADAPTER_KEYS.SK_COURTS]: [{ guid: "1" }, { guid: "2" }],
  [ADAPTER_KEYS.SK_US]: [{ documentId: "1" }, { documentId: "2" }],
  [ADAPTER_KEYS.PL_COURTS]: [{ id: 1 }, { id: 2 }],
  [ADAPTER_KEYS.PL_SN]: [{ id: "1" }, { id: "2" }],
  [ADAPTER_KEYS.PL_KIO]: [{ id: "1" }, { id: "2" }],
  [ADAPTER_KEYS.PL_TK]: [{ documentId: "1" }, { documentId: "2" }],
  [ADAPTER_KEYS.PL_NSA]: [{ identity: "1" }, { identity: "2" }],
  [ADAPTER_KEYS.PL_NCOURT]: [
    { listingXml: "<row><id>1</id></row>" },
    { listingXml: "<row><id>2</id></row>" },
  ],
  [ADAPTER_KEYS.AT_COURTS]: risIdentityPayloads,
  [ADAPTER_KEYS.AT_VFGH]: risIdentityPayloads,
  [ADAPTER_KEYS.AT_VWGH]: risIdentityPayloads,
  [ADAPTER_KEYS.AT_BVWG]: risIdentityPayloads,
  [ADAPTER_KEYS.AT_LVWG]: risIdentityPayloads,
  [ADAPTER_KEYS.AT_ASYLGH]: risIdentityPayloads,
  [ADAPTER_KEYS.AT_UBAS]: risIdentityPayloads,
  [ADAPTER_KEYS.AT_UVS]: risIdentityPayloads,
  [ADAPTER_KEYS.AT_VERG]: risIdentityPayloads,
  [ADAPTER_KEYS.AT_UMSE]: risIdentityPayloads,
  [ADAPTER_KEYS.AT_BKS]: risIdentityPayloads,
  [ADAPTER_KEYS.AT_FINDOK]: [
    { collection: "ufs", item: { dokumentId: "1" } },
    { collection: "ufs", item: { dokumentId: "2" } },
  ],
  [ADAPTER_KEYS.EU_ECJ]: [
    { celex: "62026CJ0001", language: "cs" },
    { celex: "62026CJ0002", language: "cs" },
    { celex: "62026CJ0001", language: "pl" },
  ],
  [ADAPTER_KEYS.HU_BHGY]: [{ IndexId: "1" }, { IndexId: "2" }],
  [ADAPTER_KEYS.PL_KIS]: [{ ID_INFORMACJI: "1" }, { ID_INFORMACJI: "2" }],
  [ADAPTER_KEYS.PL_UODO]: [{ refid: "urn:1" }, { refid: "urn:2" }],
  [ADAPTER_KEYS.PL_UOKIK]: [
    { "@unid": "00000000000000000000000000000001" },
    { "@unid": "00000000000000000000000000000002" },
  ],
} as const satisfies Record<AdapterKey, readonly unknown[]>;

describe("every registered adapter keeps publisher identity in its revision signal", () => {
  for (const {
    key,
    reconciliation: { revisionOf },
  } of listAdapters()) {
    test(key, () => {
      const revisions = IDENTITY_REVISION_PAYLOADS[key].map(revisionOf);
      for (const [index, revision] of revisions.entries()) {
        expect(revision).not.toBeNull();
        for (const other of revisions.slice(index + 1)) {
          expect(revision).not.toEqual(other);
        }
      }
    });
  }

  test("NALUS ECLI counter corrections revise the retained listing", () => {
    const listed = {
      caseNumber: "Pl. ÚS 1/26",
      counter: 1,
      quarantineId: "quarantine:1",
      quarantineRepairIds: [],
      listingHtml: "",
      sourceDocumentId: "123",
      sourceUrl: "https://nalus.usoud.cz/Search/GetText.aspx?sz=Pl-1-26_1",
      ecli: "ECLI:CZ:US:2026:Pl.US.1.26",
    } satisfies ListedDecision;
    expect(
      czUsAdapter.reconciliation.revisionOf({ ...listed, counter: 2 }),
    ).not.toEqual(czUsAdapter.reconciliation.revisionOf(listed));
  });
});

describe("listing revisions describe one record independently of its position", () => {
  test("UOKiK publications move positions without revising older decisions", () => {
    const revisionOf = plUokikAdapter.reconciliation.revisionOf;
    const entry = {
      "@unid": "1234567890ABCDEF1234567890ABCDEF",
      "@noteid": "1",
      "@position": "1",
      "@siblings": "10",
      entrydata: [{ text: { "0": "Numer decyzji: DKK-1/2026" } }],
    };
    const shifted = { ...entry, "@position": "2", "@siblings": "11" };
    expect(shifted).not.toEqual(entry);
    expect(revisionOf(shifted)).toEqual(revisionOf(entry));
    expect(
      revisionOf({
        ...entry,
        entrydata: [{ text: { "0": "Numer decyzji: DKK-2/2026" } }],
      }),
    ).not.toEqual(revisionOf(entry));
  });

  test("national court repair aliases move without revising listing XML", () => {
    const revisionOf = plNcourtAdapter.reconciliation.revisionOf;
    const entry = {
      listingXml: "<row><id>1</id><signature>I C 1/2026</signature></row>",
      positionAlias: "position:1",
    };
    const shifted = { ...entry, positionAlias: "position:2" };
    expect(shifted).not.toEqual(entry);
    expect(revisionOf(shifted)).toEqual(revisionOf(entry));
    expect(
      revisionOf({
        ...entry,
        listingXml: "<row><id>1</id><signature>I C 2/2026</signature></row>",
      }),
    ).not.toEqual(revisionOf(entry));
  });

  test("NSA snapshot revisions and row coordinates are not per-record revisions", () => {
    const revisionOf = plNsaAdapter.reconciliation.revisionOf;
    const entry = { revision: "old", shard: 1, row: 2, identity: "123" };
    const shifted = { ...entry, revision: "new", shard: 2, row: 3 };
    expect(shifted).not.toEqual(entry);
    expect(revisionOf(shifted)).toEqual(revisionOf(entry));
    // This listing payload has no content signal beyond the stable identity.
    expect(revisionOf({ ...entry, identity: "456" })).not.toEqual(
      revisionOf(entry),
    );
  });
});
