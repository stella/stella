import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { readDocxDeclaredSourceLanguage } from "./docx-language";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const createDocx = async ({
  documentLanguage,
  defaultLanguage,
  themeLanguage,
}: {
  documentLanguage?: string;
  defaultLanguage?: string;
  themeLanguage?: string;
}): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  const runProperties = documentLanguage
    ? `<w:rPr><w:lang w:val="${documentLanguage}"/></w:rPr>`
    : "";
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="${W_NS}"><w:body><w:p><w:r>${runProperties}<w:t>Text</w:t></w:r></w:p></w:body></w:document>`,
  );
  if (defaultLanguage) {
    zip.file(
      "word/styles.xml",
      `<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault>` +
        `<w:rPr><w:lang w:val="${defaultLanguage}"/></w:rPr>` +
        `</w:rPrDefault></w:docDefaults></w:styles>`,
    );
  }
  if (themeLanguage) {
    zip.file(
      "word/settings.xml",
      `<w:settings xmlns:w="${W_NS}">` +
        `<w:themeFontLang w:val="${themeLanguage}"/>` +
        `</w:settings>`,
    );
  }
  return await zip.generateAsync({ type: "arraybuffer" });
};

describe("DOCX declared source language", () => {
  test("prefers the default proofing language over isolated run formatting", async () => {
    const docx = await createDocx({
      defaultLanguage: "cs-CZ",
      documentLanguage: "en-US",
      themeLanguage: "en-US",
    });

    expect(await readDocxDeclaredSourceLanguage(docx)).toBe("CS");
  });

  test("uses the theme language when styles do not declare a default", async () => {
    const docx = await createDocx({ themeLanguage: "pt-BR" });

    expect(await readDocxDeclaredSourceLanguage(docx)).toBe("PT-PT");
  });

  test("falls back to explicit run metadata", async () => {
    const docx = await createDocx({ documentLanguage: "sk-SK" });

    expect(await readDocxDeclaredSourceLanguage(docx)).toBe("SK");
  });

  test("returns null for an unsupported declared language", async () => {
    const docx = await createDocx({ defaultLanguage: "he-IL" });

    expect(await readDocxDeclaredSourceLanguage(docx)).toBeNull();
  });
});
