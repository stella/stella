import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { DocumentSource } from "@/api/lib/document-source";
import {
  DOCUMENT_SOURCE_KINDS,
  documentSourceKind,
  documentSourceSchema,
  isImportedDocumentSource,
} from "@/api/lib/document-source";

const sampleFor = (kind: DocumentSource["kind"]): DocumentSource => {
  switch (kind) {
    case "upload":
      return { kind: "upload" };
    case "desktop-edit":
      return { kind: "desktop-edit" };
    case "sharepoint":
      return {
        kind: "sharepoint",
        driveId: "b!drive",
        itemId: "01ITEM",
        eTag: '"{GUID},1"',
        webUrl: "https://contoso.sharepoint.com/x.docx",
      };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

describe("DocumentSource narrowing", () => {
  test("documentSourceKind echoes the discriminator for every branch", () => {
    for (const kind of DOCUMENT_SOURCE_KINDS) {
      expect(documentSourceKind(sampleFor(kind))).toBe(kind);
    }
  });

  test("only the sharepoint branch is an import", () => {
    expect(isImportedDocumentSource({ kind: "upload" })).toBe(false);
    expect(isImportedDocumentSource({ kind: "desktop-edit" })).toBe(false);
    expect(isImportedDocumentSource(sampleFor("sharepoint"))).toBe(true);
  });

  test("schema parses each branch and rejects a write-shaped extra", () => {
    for (const kind of DOCUMENT_SOURCE_KINDS) {
      expect(v.parse(documentSourceSchema, sampleFor(kind)).kind).toBe(kind);
    }
    // A sharepoint source missing required provenance fields is rejected.
    expect(v.is(documentSourceSchema, { kind: "sharepoint" })).toBe(false);
    // An unknown kind is rejected.
    expect(v.is(documentSourceSchema, { kind: "onedrive-write" })).toBe(false);
  });
});
