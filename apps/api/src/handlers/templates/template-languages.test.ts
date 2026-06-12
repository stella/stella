import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  detectTemplateLanguages,
  detectTemplateLanguagesFromDocx,
  LANGUAGE_STOPWORDS,
  normalizeTemplateLanguages,
} from "@/api/handlers/templates/template-languages";

// ── normalizeTemplateLanguages ───────────────────────────

describe("normalizeTemplateLanguages", () => {
  test("trims, canonicalizes to base ISO 639-1, dedupes, preserves order", () => {
    const result = normalizeTemplateLanguages([" PL ", "en-gb", "pl", "EN-GB"]);
    expect(result).toEqual({ ok: true, languages: ["pl", "en"] });
  });

  test("canonicalizes regional UI tags onto their base code", () => {
    // The UI ships pt-BR, but template storage keys on the base code pt.
    expect(normalizeTemplateLanguages(["pt-BR", "en_US"])).toEqual({
      ok: true,
      languages: ["pt", "en"],
    });
  });

  test("skips empty entries", () => {
    const result = normalizeTemplateLanguages(["", "  ", "cs"]);
    expect(result).toEqual({ ok: true, languages: ["cs"] });
  });

  test("accepts an empty list", () => {
    expect(normalizeTemplateLanguages([])).toEqual({
      ok: true,
      languages: [],
    });
  });

  test("drops unknown or malformed tags rather than rejecting", () => {
    // Lenient on input: stray/unknown tags never block a save, they are
    // silently dropped; only known codes survive.
    const result = normalizeTemplateLanguages([
      "not a tag",
      "-pl",
      "a",
      "zz",
      "cs",
    ]);
    expect(result).toEqual({ ok: true, languages: ["cs"] });
  });

  test("rejects more than the maximum number of languages", () => {
    const result = normalizeTemplateLanguages(["pl", "en", "de", "fr", "cs"]);
    expect(result.ok).toBe(false);
  });
});

// ── detectTemplateLanguages ──────────────────────────────

/** Repeat so short snippets clear the absolute-hits floor the way a real
 *  multi-page document would. */
const grow = (snippet: string) =>
  Array.from({ length: 6 }, () => snippet).join(" ");

const SNIPPETS: Record<string, string> = {
  en: grow(
    "This agreement is concluded by and between the parties for the purpose " +
      "of regulating the rights and obligations that the parties shall " +
      "perform, and any dispute shall be resolved by the courts.",
  ),
  pl: grow(
    "Niniejszej umowy nie można zmieniać inaczej niż przez formę pisemną, " +
      "która jest zastrzeżona dla wszelkich zmian, oraz strony są zgodnie " +
      "zobowiązane do wykonywania postanowień, które się do nich odnoszą.",
  ),
  cs: grow(
    "Podle této smlouvy jsou strany povinny plnit závazky, které byly " +
      "sjednány, nebo pokud to není možné, jednat při plnění tak, aby již " +
      "nedošlo ke škodě, která by mohla vzniknout mezi stranami.",
  ),
  sk: grow(
    "Podľa tejto zmluvy sú strany povinné plniť záväzky, ktoré boli " +
      "dohodnuté, alebo ak to nie je možné, konať pri plnení tak, aby už " +
      "nevznikla škoda, ktorá by mohla vzniknúť medzi stranami.",
  ),
  es: grow(
    "Según el presente contrato, las partes y sus representantes deberán " +
      "cumplir las obligaciones del acuerdo cuando una de las partes lo " +
      "solicite mediante notificación, y los plazos del contrato.",
  ),
  pt: grow(
    "As partes não poderão ceder os direitos da presente cláusula, e são " +
      "obrigadas, quando uma notificação for entregue ao devedor pelo " +
      "credor, a cumprir também os seus deveres em conjunto.",
  ),
};

describe("detectTemplateLanguages", () => {
  test("stopword sets are pairwise disjoint", () => {
    // A shared word would silently credit the wrong language, so every
    // word must map to exactly one language.
    const seen = new Map<string, string>();
    for (const [tag, words] of Object.entries(LANGUAGE_STOPWORDS)) {
      for (const word of words) {
        const owner = seen.get(word);
        expect(owner === undefined ? tag : `${owner}+${tag}:${word}`).toBe(tag);
        seen.set(word, tag);
      }
    }
  });

  test("detects each snippet language as dominant", () => {
    for (const [tag, text] of Object.entries(SNIPPETS)) {
      expect(detectTemplateLanguages(text).at(0)).toBe(tag);
    }
  });

  test("close pairs do not cross-detect (cs/sk, es/pt)", () => {
    expect(detectTemplateLanguages(SNIPPETS["cs"] ?? "")).toEqual(["cs"]);
    expect(detectTemplateLanguages(SNIPPETS["sk"] ?? "")).toEqual(["sk"]);
    expect(detectTemplateLanguages(SNIPPETS["es"] ?? "")).toEqual(["es"]);
    expect(detectTemplateLanguages(SNIPPETS["pt"] ?? "")).toEqual(["pt"]);
  });

  test("bilingual document yields both languages, dominant first", () => {
    const pl = SNIPPETS["pl"] ?? "";
    const en = SNIPPETS["en"] ?? "";
    const detected = detectTemplateLanguages(`${pl}\n${pl}\n${en}`);
    expect(detected).toEqual(["pl", "en"]);
  });

  test("returns [] for empty, numeric, or undetectable text", () => {
    expect(detectTemplateLanguages("")).toEqual([]);
    expect(detectTemplateLanguages("123 456 789 §1 §2")).toEqual([]);
    expect(detectTemplateLanguages("lorem ipsum dolor sit amet")).toEqual([]);
  });
});

// ── detectTemplateLanguagesFromDocx ──────────────────────

const makeDocx = async (paragraphs: string[]): Promise<Uint8Array> => {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join("");
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org` +
      `/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org` +
      `/package/2006/content-types">` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="rels" ContentType="application/vnd.` +
      `openxmlformats-package.relationships+xml"/></Types>`,
  );
  return zip.generateAsync({ type: "uint8array" });
};

describe("detectTemplateLanguagesFromDocx", () => {
  test("detects languages from document paragraphs", async () => {
    const docx = await makeDocx([SNIPPETS["en"] ?? ""]);
    expect(await detectTemplateLanguagesFromDocx(docx)).toEqual(["en"]);
  });

  test("returns [] for an unreadable file instead of throwing", async () => {
    const garbage = new TextEncoder().encode("not a zip archive");
    expect(await detectTemplateLanguagesFromDocx(garbage)).toEqual([]);
  });
});
