import { describe, expect, test } from "bun:test";

import { parseFootnoteProperties } from "./notePropertiesParser";
import { findChild, parseXmlDocument } from "./xmlParser";

describe("note properties number formats", () => {
  test("keeps specialized OOXML number formats", () => {
    const root = parseXmlDocument(
      `<w:sectPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:footnotePr>
          <w:numFmt w:val="hindiCounting"/>
        </w:footnotePr>
      </w:sectPr>`,
    );

    expect(
      parseFootnoteProperties(findChild(root, "w", "footnotePr")).numFmt,
    ).toBe("hindiCounting");
  });
});
