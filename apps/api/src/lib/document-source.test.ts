import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { documentSourceSchema } from "@/api/lib/document-source";

describe("documentSourceSchema", () => {
  test("accepts browser collaboration provenance", () => {
    expect(v.parse(documentSourceSchema, { kind: "collaboration" })).toEqual({
      kind: "collaboration",
    });
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
