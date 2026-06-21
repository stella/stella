import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { createDocx, createEmptyDocument } from "@stll/folio/server";

import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import { readManifest } from "@/api/handlers/docx/template-manifest";

// The blank-create handler's only logic on top of the shared
// `createStoredTemplate` recipe is generating the source buffer from a
// Folio-native empty document. These tests pin that contract: the buffer is a
// valid DOCX the discovery pipeline accepts as a zero-field template, with no
// embedded manifest. `createStoredTemplate` (DB + S3) is exercised by the REST
// create path; here we only guard the blank buffer it consumes.
describe("blank template buffer", () => {
  test("createDocx(createEmptyDocument()) is a non-empty, openable DOCX", async () => {
    const buffer = Buffer.from(
      new Uint8Array(await createDocx(createEmptyDocument())),
    );

    expect(buffer.byteLength).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file("word/document.xml")).not.toBeNull();
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
  });

  test("discovers zero fields and carries no embedded manifest", async () => {
    const buffer = Buffer.from(
      new Uint8Array(await createDocx(createEmptyDocument())),
    );

    const [discovered, manifest] = await Promise.all([
      discoverTemplate(buffer),
      readManifest(buffer),
    ]);

    expect(discovered.fields).toHaveLength(0);
    expect(discovered.placeholders).toHaveLength(0);
    expect(manifest).toBeNull();
  });
});
