import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { documentSourceSchema } from "@/api/lib/document-source";

describe("documentSourceSchema", () => {
  test("accepts browser collaboration provenance", () => {
    expect(v.parse(documentSourceSchema, { kind: "collaboration" })).toEqual({
      kind: "collaboration",
    });
  });

  test("accepts complete comparison provenance and rejects partial provenance", () => {
    const comparison = {
      kind: "comparison",
      baseVersionId: "00000000-0000-4000-8000-000000000001",
      targetVersionId: "00000000-0000-4000-8000-000000000002",
      mode: "best-effort",
      granularity: "character",
      baseTrackedChanges: "reject",
      targetTrackedChanges: "accept",
    };

    expect(v.parse(documentSourceSchema, comparison)).toEqual(comparison);
    expect(
      v.is(documentSourceSchema, {
        ...comparison,
        targetVersionId: undefined,
      }),
    ).toBe(false);
  });

  test("accepts complete import provenance and rejects invalid sources", () => {
    expect(
      v.parse(documentSourceSchema, {
        kind: "sharepoint",
        driveId: "b!drive",
        itemId: "01ITEM",
        eTag: '"{GUID},1"',
        webUrl: "https://contoso.sharepoint.com/x.docx",
      }),
    ).toMatchObject({ kind: "sharepoint", itemId: "01ITEM" });
    // A sharepoint source missing required provenance fields is rejected.
    expect(v.is(documentSourceSchema, { kind: "sharepoint" })).toBe(false);
    // An unknown kind is rejected.
    expect(v.is(documentSourceSchema, { kind: "onedrive-write" })).toBe(false);
  });
});
