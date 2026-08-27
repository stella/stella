import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { readDocxDeclaredSourceLanguage } from "./docx-language";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

type LanguageDeclarations = {
  bidi?: string;
  eastAsia?: string;
  val?: string;
};

type DocumentRun = LanguageDeclarations & {
  text: string;
};

const languageAttributes = ({
  bidi,
  eastAsia,
  val,
}: LanguageDeclarations): string =>
  [
    val ? `w:val="${val}"` : "",
    eastAsia ? `w:eastAsia="${eastAsia}"` : "",
    bidi ? `w:bidi="${bidi}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

const createDocx = async ({
  defaultLanguages,
  documentRuns,
  documentLanguage,
  defaultLanguage,
  themeLanguages,
  themeLanguage,
}: {
  defaultLanguages?: LanguageDeclarations;
  documentRuns?: readonly DocumentRun[];
  documentLanguage?: string;
  defaultLanguage?: string;
  themeLanguages?: LanguageDeclarations;
  themeLanguage?: string;
}): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  const runs = documentRuns ?? [
    { text: "Text", ...(documentLanguage ? { val: documentLanguage } : {}) },
  ];
  const runXml = runs
    .map((run) => {
      const attributes = languageAttributes(run);
      const runProperties = attributes
        ? `<w:rPr><w:lang ${attributes}/></w:rPr>`
        : "";
      return `<w:r>${runProperties}<w:t>${run.text}</w:t></w:r>`;
    })
    .join("");
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="${W_NS}"><w:body><w:p>${runXml}</w:p></w:body></w:document>`,
  );
  const defaultAttributes = languageAttributes(
    defaultLanguages ?? (defaultLanguage ? { val: defaultLanguage } : {}),
  );
  if (defaultAttributes) {
    zip.file(
      "word/styles.xml",
      `<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault>` +
        `<w:rPr><w:lang ${defaultAttributes}/></w:rPr>` +
        `</w:rPrDefault></w:docDefaults></w:styles>`,
    );
  }
  const themeAttributes = languageAttributes(
    themeLanguages ?? (themeLanguage ? { val: themeLanguage } : {}),
  );
  if (themeAttributes) {
    zip.file(
      "word/settings.xml",
      `<w:settings xmlns:w="${W_NS}">` +
        `<w:themeFontLang ${themeAttributes}/>` +
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

  test("uses the Latin proofing language for Latin-script document text", async () => {
    const docx = await createDocx({
      defaultLanguages: {
        bidi: "ar-SA",
        eastAsia: "en-US",
        val: "cs-CZ",
      },
      documentRuns: [{ text: "Český právní dokument" }],
    });

    expect(await readDocxDeclaredSourceLanguage(docx)).toBe("CS");
  });

  test("uses the East Asian proofing language for East Asian text", async () => {
    const docx = await createDocx({
      defaultLanguages: { eastAsia: "zh-CN", val: "en-US" },
      documentRuns: [{ text: "这是中文法律文件" }],
    });

    expect(await readDocxDeclaredSourceLanguage(docx)).toBe("ZH");
  });

  test("uses the bidirectional proofing language for Arabic text", async () => {
    const docx = await createDocx({
      defaultLanguages: { bidi: "ar-SA", val: "en-US" },
      documentRuns: [{ text: "هذه وثيقة قانونية" }],
    });

    expect(await readDocxDeclaredSourceLanguage(docx)).toBe("AR");
  });

  test("weights direct run metadata by governed text", async () => {
    const docx = await createDocx({
      documentRuns: [
        {
          text: "This is a substantially longer English passage",
          val: "en-US",
        },
        { text: "Ja", val: "de-DE" },
        { text: "Nein", val: "de-DE" },
      ],
    });

    expect(await readDocxDeclaredSourceLanguage(docx)).toBe("EN-GB");
  });

  test("returns null for conflicting direct run metadata", async () => {
    const docx = await createDocx({
      documentRuns: [
        { text: "English", val: "en-US" },
        { text: "Deutsch", val: "de-DE" },
      ],
    });

    expect(await readDocxDeclaredSourceLanguage(docx)).toBeNull();
  });

  test("returns null for an unsupported declared language", async () => {
    const docx = await createDocx({ defaultLanguage: "he-IL" });

    expect(await readDocxDeclaredSourceLanguage(docx)).toBeNull();
  });
});
