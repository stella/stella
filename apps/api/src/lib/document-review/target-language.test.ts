import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  foreignLanguageOf,
  languageDisplayName,
  resolveReviewTargetLanguage,
} from "@/api/lib/document-review/target-language";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";

const document = (texts: readonly string[]): PreparedDocxFile => ({
  kind: "docx",
  fileFieldId: toSafeId<"field">("field-fixture"),
  fileId: "file-fixture",
  simplifiedName: "F0",
  blocks: texts.map((text, index) => ({
    id: `p-${String(index)}`,
    kind: "paragraph",
    text,
  })),
});

const CZECH_CLAUSE =
  "Poskytovatel odpovídá za škodu způsobenou porušením této smlouvy a nahradí ji objednateli.";
const ENGLISH_CLAUSE =
  "The provider is liable for damage caused by a breach of this agreement and shall compensate the customer.";

describe("resolveReviewTargetLanguage", () => {
  test("reads the document as a whole, not one block", () => {
    expect(
      resolveReviewTargetLanguage(
        document([
          "Smlouva o dílo",
          "Tato smlouva se řídí právním řádem České republiky.",
          "Smluvní strany se zavazují řešit veškeré spory přednostně smírnou cestou.",
          CZECH_CLAUSE,
          "Objednatel je povinen uhradit cenu díla do třiceti dnů ode dne doručení faktury.",
        ]),
      ),
    ).toBe("CS");
  });

  test("a document with too little text has no resolved language", () => {
    expect(resolveReviewTargetLanguage(document(["Schedule 1"]))).toBeNull();
  });
});

describe("foreignLanguageOf", () => {
  test("names the language of text confidently written in another", () => {
    expect(foreignLanguageOf(ENGLISH_CLAUSE, "CS")).toBe("EN-GB");
  });

  test("text in the target's language is not foreign", () => {
    expect(foreignLanguageOf(CZECH_CLAUSE, "CS")).toBeNull();
  });

  // A short term carries too little evidence; the prompt, not the guard, keeps
  // it in line.
  test("text too short to detect is not foreign", () => {
    expect(foreignLanguageOf("6 months", "CS")).toBeNull();
  });

  test("no resolved target language means nothing is foreign", () => {
    expect(foreignLanguageOf(ENGLISH_CLAUSE, null)).toBeNull();
  });
});

describe("languageDisplayName", () => {
  test("names a language the way a prompt reads it", () => {
    expect(languageDisplayName("CS")).toBe("Czech");
    expect(languageDisplayName("PT-PT")).toBe("European Portuguese");
  });
});
