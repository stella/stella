import { describe, expect, test } from "bun:test";

import type { Document } from "../types/document";
import { inspectDocxCompatibility } from "./compatibility";

const createDocument = (rawXml?: string): Document => ({
  package: {
    document: {
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "run",
              content: [
                { type: "text", text: "Body" },
                {
                  type: "drawing",
                  image: {
                    type: "image",
                    rId: "rId1",
                    size: { width: 9525, height: 9525 },
                    wrap: { type: "inline" },
                  },
                  ...(rawXml !== undefined ? { rawXml } : {}),
                },
              ],
            },
          ],
        },
      ],
    },
  },
});

describe("DOCX compatibility inspection", () => {
  test("allows editing ordinary parsed content", () => {
    expect(inspectDocxCompatibility(createDocument())).toEqual({
      canSafelyEdit: true,
      reasons: [],
      unsupportedContentCount: 0,
    });
  });

  test("blocks editing when the document contains opaque drawing XML", () => {
    expect(inspectDocxCompatibility(createDocument("<w:drawing/>"))).toEqual({
      canSafelyEdit: false,
      reasons: ["opaqueDrawing"],
      unsupportedContentCount: 1,
    });
  });
});
