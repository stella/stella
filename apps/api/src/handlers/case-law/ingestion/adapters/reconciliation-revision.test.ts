import { describe, expect, test } from "bun:test";

import { plNcourtAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt";
import { plNsaAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa";
import { plUokikAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-uokik";

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
