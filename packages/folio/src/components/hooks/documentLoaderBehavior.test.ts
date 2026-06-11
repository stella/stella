import { describe, expect, test } from "bun:test";

import type { Document } from "../../core/types/document";
import { getDocumentLoadSource } from "./documentLoaderBehavior";

const document: Document = {
  package: {
    document: {
      content: [],
    },
  },
};

describe("document loader behavior", () => {
  test("loads the document buffer when one is provided", () => {
    const buffer = new ArrayBuffer(8);

    expect(
      getDocumentLoadSource({
        documentBuffer: buffer,
        initialDocument: document,
      }),
    ).toEqual({ type: "buffer", buffer });
  });

  test("loads the parsed initial document when no buffer is provided", () => {
    expect(
      getDocumentLoadSource({
        documentBuffer: null,
        initialDocument: document,
      }),
    ).toEqual({ type: "parsed-document", document });
  });

  test("does not load when neither source is provided", () => {
    expect(
      getDocumentLoadSource({
        documentBuffer: undefined,
        initialDocument: null,
      }),
    ).toEqual({ type: "none" });
  });
});
