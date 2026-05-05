import { describe, expect, test } from "bun:test";

import type { Document } from "../../core/types/document";
import { replaceTextInDocument } from "../../core/utils/replaceText";
import {
  createDefaultFindOptions,
  findInDocument,
  scrollToMatch,
} from "./findReplaceUtils";

const createTableDocument = (): Document => ({
  package: {
    document: {
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "run",
              content: [{ type: "text", text: "Outside text" }],
            },
          ],
        },
        {
          type: "table",
          rows: [
            {
              cells: [
                {
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "run",
                          content: [{ type: "text", text: "Inside table" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  },
});

describe("Folio find and replace", () => {
  test("finds text inside table cells", () => {
    const matches = findInDocument(
      createTableDocument(),
      "Inside",
      createDefaultFindOptions(),
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.paragraphIndex).toBe(1);
    expect(matches[0]?.startOffset).toBe(0);
  });

  test("reports match offsets relative to the whole paragraph", () => {
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "Series " }],
                },
                {
                  type: "run",
                  content: [{ type: "text", text: "Stock" }],
                },
              ],
            },
          ],
        },
      },
    };

    const matches = findInDocument(
      document,
      "stock",
      createDefaultFindOptions(),
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.contentIndex).toBe(1);
    expect(matches[0]?.startOffset).toBe(7);
    expect(matches[0]?.endOffset).toBe(12);
  });

  test("replaces matches inside table cells", () => {
    const document = createTableDocument();
    const match = findInDocument(
      document,
      "Inside",
      createDefaultFindOptions(),
    )[0];
    if (!match) {
      throw new Error("Expected table-cell match");
    }

    const replaced = replaceTextInDocument(
      document,
      {
        start: {
          paragraphIndex: match.paragraphIndex,
          offset: match.startOffset,
        },
        end: {
          paragraphIndex: match.paragraphIndex,
          offset: match.endOffset,
        },
      },
      "Within",
    );

    expect(
      findInDocument(replaced, "Within table", createDefaultFindOptions()),
    ).toHaveLength(1);
  });

  test("scrolls to rendered layout paragraphs when legacy paragraph indexes are absent", () => {
    let scrolled = false;
    const second = {
      scrollIntoView: () => {
        scrolled = true;
      },
    };
    const paragraphs = {
      item: (index: number) => (index === 1 ? second : null),
    };
    const container = {
      querySelector: (selector: string) => {
        if (selector.includes('data-block-id="block-2"')) {
          return second;
        }
        return null;
      },
      querySelectorAll: () => paragraphs,
    };

    // SAFETY: scrollToMatch only uses querySelector/querySelectorAll and
    // scrollIntoView; this fake keeps the browser-dependent test deterministic.
    scrollToMatch(container as unknown as HTMLElement, {
      paragraphIndex: 1,
      contentIndex: 0,
      startOffset: 0,
      endOffset: 6,
      text: "Inside",
    });

    expect(scrolled).toBe(true);
  });

  test("falls back to rendered paragraph order if generated block ids drift", () => {
    let scrolled = false;
    const second = {
      scrollIntoView: () => {
        scrolled = true;
      },
    };
    const paragraphs = {
      item: (index: number) => (index === 1 ? second : null),
    };
    const container = {
      querySelector: () => null,
      querySelectorAll: () => paragraphs,
    };

    // SAFETY: scrollToMatch only uses querySelector/querySelectorAll and
    // scrollIntoView; this fake keeps the browser-dependent test deterministic.
    scrollToMatch(container as unknown as HTMLElement, {
      paragraphIndex: 1,
      contentIndex: 0,
      startOffset: 0,
      endOffset: 6,
      text: "Inside",
    });

    expect(scrolled).toBe(true);
  });
});
