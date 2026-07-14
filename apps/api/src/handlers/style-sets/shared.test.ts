import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  createDocx,
  createEmptyDocument,
  createStellaStyleDocumentPreset,
} from "@stll/folio-core/server";

import {
  extractStyleSetBuffer,
  normalizeStyleSetName,
  validateStyleSource,
} from "@/api/lib/style-sets";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

describe("style set source extraction", () => {
  test("normalizes names and rejects whitespace-only input", () => {
    const normalized = normalizeStyleSetName("  Firm Style  ");
    expect(Result.isOk(normalized)).toBe(true);
    if (Result.isOk(normalized)) {
      expect(normalized.value).toBe("Firm Style");
    }
    expect(Result.isError(normalizeStyleSetName("   "))).toBe(true);
  });

  test("rejects a source that is not a DOCX", () => {
    const source = new File(["not a document"], "styles.pdf", {
      type: "application/pdf",
    });

    expect(Result.isError(validateStyleSource(source))).toBe(true);
  });

  test("stores formatting without source document content", async () => {
    const sourceText = "PRIVATE SOURCE AGREEMENT";
    const sourceBytes = await createDocx(
      createEmptyDocument({
        initialText: sourceText,
        preset: createStellaStyleDocumentPreset(),
      }),
    );
    const source = new File([sourceBytes], "firm-styles.docx", {
      type: DOCX_MIME_TYPE,
    });

    const result = await extractStyleSetBuffer(source, "Firm Style");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }

    const zip = await JSZip.loadAsync(result.value);
    const documentXml = await zip.file("word/document.xml")?.async("text");
    const stylesXml = await zip.file("word/styles.xml")?.async("text");
    expect(documentXml).not.toContain(sourceText);
    expect(stylesXml).toContain('w:styleId="BodyText"');
  });
});
