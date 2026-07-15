import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  createDocx,
  createEmptyDocument,
  createStellaStyleDocumentPreset,
} from "@stll/folio-core/server";

import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import { readManifest } from "@/api/handlers/docx/template-manifest";
import { createTemplateBuffer } from "@/api/lib/create-template-buffer";

// The blank-create handler's only logic on top of the shared
// `createStoredTemplate` recipe is generating the source buffer from a
// Folio-native empty document. These tests pin that contract: the buffer is a
// valid DOCX the discovery pipeline accepts as a zero-field template, with no
// embedded manifest. `createStoredTemplate` (DB + S3) is exercised by the REST
// create path; here we only guard the blank buffer it consumes.
describe("blank template buffer", () => {
  test("the default is a non-empty, openable stella style DOCX", async () => {
    const buffer = await createTemplateBuffer({ type: "stella" });

    expect(buffer.byteLength).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file("word/document.xml")).not.toBeNull();
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    const styles = await zip.file("word/styles.xml")?.async("text");
    expect(styles).toContain('w:styleId="BodyText"');
    expect(styles).toContain('w:styleId="ClauseHeading1"');
    expect(styles).toContain('w:ascii="Arial"');
  });

  test("discovers zero fields and carries no embedded manifest", async () => {
    const buffer = await createTemplateBuffer({ type: "stella" });

    const [discovered, manifest] = await Promise.all([
      discoverTemplate(buffer),
      readManifest(buffer),
    ]);

    expect(discovered.fields).toHaveLength(0);
    expect(discovered.placeholders).toHaveLength(0);
    expect(manifest).toBeNull();
  });

  test("keeps extracted styles but never source document content", async () => {
    const sourceText = "CONFIDENTIAL SOURCE CONTENT";
    const source = Buffer.from(
      new Uint8Array(
        await createDocx(
          createEmptyDocument({
            initialText: sourceText,
            preset: createStellaStyleDocumentPreset(),
          }),
        ),
      ),
    );

    const buffer = await createTemplateBuffer({
      type: "style-source",
      buffer: source,
      name: "Imported styles",
    });
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file("word/document.xml")?.async("text");
    const stylesXml = await zip.file("word/styles.xml")?.async("text");

    expect(documentXml).not.toContain(sourceText);
    expect(stylesXml).toContain('w:styleId="BodyText"');
    expect(stylesXml).toContain('w:styleId="ClauseParagraph1"');
    expect(stylesXml).toContain('w:styleId="ClauseParagraph2"');
  });
});
