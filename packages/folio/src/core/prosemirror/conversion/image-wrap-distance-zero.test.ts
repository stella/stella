import { describe, expect, test } from "bun:test";

import type { Document, Image } from "../../types/document";
import { toProseDoc } from "./toProseDoc";

const EMUS_PER_INCH = 914_400;

const docWithImage = (image: Image): Document => ({
  package: {
    document: {
      content: [
        {
          type: "paragraph",
          content: [{ type: "run", content: [{ type: "drawing", image }] }],
        },
      ],
    },
  },
});

const floatingImage = (wrap: Image["wrap"]): Image => ({
  type: "image",
  rId: "rId1",
  src: "data:image/png;base64,AA==",
  size: { width: EMUS_PER_INCH, height: EMUS_PER_INCH },
  wrap,
});

const firstImageAttrs = (document: Document): Record<string, unknown> => {
  let attrs: Record<string, unknown> | undefined;
  toProseDoc(document).descendants((node) => {
    if (node.type.name !== "image") {
      return true;
    }
    attrs = node.attrs;
    return false;
  });

  if (!attrs) {
    throw new Error("Expected an image node");
  }
  return attrs;
};

describe("image wrap distance conversion", () => {
  test("preserves explicit zero wrap distances", () => {
    const attrs = firstImageAttrs(
      docWithImage(
        floatingImage({
          type: "square",
          distT: 0,
          distB: 0,
          distL: 0,
          distR: 0,
        }),
      ),
    );

    expect(attrs["distTop"]).toBe(0);
    expect(attrs["distBottom"]).toBe(0);
    expect(attrs["distLeft"]).toBe(0);
    expect(attrs["distRight"]).toBe(0);
  });

  test("keeps absent wrap distances absent", () => {
    const attrs = firstImageAttrs(
      docWithImage(floatingImage({ type: "square" })),
    );

    expect(attrs["distTop"]).toBeNull();
    expect(attrs["distLeft"]).toBeNull();
  });
});
