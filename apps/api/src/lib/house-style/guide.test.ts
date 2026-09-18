import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  HOUSE_DOCUMENT_XML,
  HOUSE_NUMBERING_XML,
  HOUSE_STYLES_XML,
  SYNTHETIC_GUIDE_DRAFT,
} from "@/api/lib/house-style/__fixtures__/synthetic-style-set";
import { extractStyleCatalogue } from "@/api/lib/house-style/catalogue";
import {
  bindStyleGuide,
  isStyleGuideCurrent,
  parseStyleGuideDraft,
} from "@/api/lib/house-style/guide";

const catalogue = extractStyleCatalogue({
  stylesXml: HOUSE_STYLES_XML,
  numberingXml: HOUSE_NUMBERING_XML,
  documentXml: HOUSE_DOCUMENT_XML,
});

const draft = () => structuredClone(SYNTHETIC_GUIDE_DRAFT);

const firstEntry = () => {
  const entry = draft().styles.at(0);
  if (entry === undefined) {
    throw new Error("the synthetic guide is empty");
  }
  return entry;
};

describe("reading a style guide", () => {
  test("accepts a guide in its shape", () => {
    const parsed = parseStyleGuideDraft(draft());
    expect(Result.isOk(parsed)).toBe(true);
  });

  test("refuses a guide missing a field, naming what is wrong", () => {
    const { purpose: _dropped, ...withoutPurpose } = firstEntry();
    const parsed = parseStyleGuideDraft({ styles: [withoutPurpose] });
    expect(Result.isError(parsed)).toBe(true);
    if (Result.isError(parsed)) {
      expect(parsed.error.message).toContain("does not match its shape");
    }
  });

  test("refuses an unknown field rather than dropping it", () => {
    const parsed = parseStyleGuideDraft({
      styles: [{ ...firstEntry(), tone: "formal" }],
    });
    expect(Result.isError(parsed)).toBe(true);
  });

  test("refuses an empty guide", () => {
    expect(Result.isError(parseStyleGuideDraft({ styles: [] }))).toBe(true);
  });
});

describe("binding a guide to a style set", () => {
  test("stamps it with the catalogue it describes", () => {
    const bound = bindStyleGuide({ draft: draft(), catalogue });
    expect(Result.isOk(bound)).toBe(true);
    if (Result.isOk(bound)) {
      expect(bound.value.catalogueHash).toBe(catalogue.hash);
      expect(isStyleGuideCurrent(bound.value, catalogue)).toBe(true);
    }
  });

  test("refuses an entry naming a style the set does not carry", () => {
    const bound = bindStyleGuide({
      draft: {
        styles: [
          ...draft().styles,
          { ...firstEntry(), id: "NoSuchStyle", name: "No such style" },
        ],
      },
      catalogue,
    });
    expect(Result.isError(bound)).toBe(true);
    if (Result.isError(bound) && bound.error._tag === "StyleGuideError") {
      expect(bound.error.unknownStyleIds).toEqual(["NoSuchStyle"]);
    }
  });

  test("refuses a guide written against another version of the style set", () => {
    const bound = bindStyleGuide({
      draft: { ...draft(), catalogueHash: "written-for-another-file" },
      catalogue,
    });
    expect(Result.isError(bound)).toBe(true);
    if (Result.isError(bound)) {
      expect(bound.error._tag).toBe("StyleGuideStaleError");
    }
  });

  test("goes stale when the style set's file is replaced", () => {
    const bound = bindStyleGuide({ draft: draft(), catalogue });
    const replaced = extractStyleCatalogue({
      stylesXml: HOUSE_STYLES_XML.replace(
        '<w:sz w:val="32"/>',
        '<w:sz w:val="24"/>',
      ),
      numberingXml: HOUSE_NUMBERING_XML,
      documentXml: HOUSE_DOCUMENT_XML,
    });
    expect(Result.isOk(bound)).toBe(true);
    if (Result.isOk(bound)) {
      expect(isStyleGuideCurrent(bound.value, replaced)).toBe(false);
    }
  });
});
