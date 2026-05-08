import { describe, expect, test } from "bun:test";

import type {
  DocumentBody,
  Paragraph,
  SectionProperties,
} from "../../core/types/document";
import { resolveEffectiveSectionProperties } from "./useHeaderFooterEditor";

const paragraph: Paragraph = {
  type: "paragraph",
  content: [],
};

describe("resolveEffectiveSectionProperties", () => {
  test("uses the first content section instead of an empty final section", () => {
    const firstSection: SectionProperties = {
      marginTop: 1296,
      headerDistance: 288,
      titlePg: true,
    };
    const emptyFinalSection: SectionProperties = {
      marginTop: 1728,
      headerDistance: 1872,
      titlePg: true,
    };
    const body: DocumentBody = {
      content: [paragraph],
      sections: [
        {
          properties: firstSection,
          content: [paragraph],
        },
        {
          properties: emptyFinalSection,
          content: [],
        },
      ],
      finalSectionProperties: emptyFinalSection,
    };

    expect(resolveEffectiveSectionProperties(body, true)).toBe(firstSection);
  });

  test("preserves title-page mode when inherited from header references", () => {
    const firstSection: SectionProperties = {
      headerDistance: 288,
    };
    const body: DocumentBody = {
      content: [paragraph],
      sections: [
        {
          properties: firstSection,
          content: [paragraph],
        },
      ],
    };

    expect(resolveEffectiveSectionProperties(body, true)).toEqual({
      headerDistance: 288,
      titlePg: true,
    });
  });
});
