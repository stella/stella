import { describe, expect, test } from "bun:test";

import { parseDocx } from "../../docx/parser";
import { validateProseMirrorDocument } from "../validation";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const FIXTURE_NAMES = ["sample.docx", "docx-editor-demo.docx"] as const;

describe("real DOCX fixture ProseMirror boundary", () => {
  for (const fixtureName of FIXTURE_NAMES) {
    test(`${fixtureName} parses into valid canonical ProseMirror attrs`, async () => {
      const buffer = await Bun.file(
        new URL(
          `../../../../tests/visual/fixtures/${fixtureName}`,
          import.meta.url,
        ),
      ).arrayBuffer();

      const document = await parseDocx(buffer, { preloadFonts: false });
      const pmDoc = toProseDoc(document, {
        styles: document.package.styles,
        theme: document.package.theme,
      });
      const validation = validateProseMirrorDocument(pmDoc);

      expect(validation.issues).toEqual([]);
      expect(validation.valid).toBe(true);

      const roundtripped = fromProseDoc(pmDoc, document);
      expect(roundtripped.package.document.content.length).toBeGreaterThan(0);
    });
  }
});
