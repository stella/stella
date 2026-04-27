import { describe, expect, test } from "bun:test";

import type { Hyperlink, RelationshipMap } from "../types/document";
import { resolveHyperlinkUrl } from "./hyperlinkParser";

describe("hyperlink parsing", () => {
  test("sanitizes relationship targets when resolving deferred hyperlinks", () => {
    const executableUrl = ["java", "script:alert(1)"].join("");
    const hyperlink: Hyperlink = {
      type: "hyperlink",
      rId: "rId1",
      children: [],
    };
    const rels: RelationshipMap = new Map([
      [
        "rId1",
        {
          id: "rId1",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
          target: executableUrl,
          targetMode: "External",
        },
      ],
    ]);

    expect(resolveHyperlinkUrl(hyperlink, rels)).toBeUndefined();
    expect(hyperlink.href).toBeUndefined();
  });

  test("keeps safe relationship targets when resolving deferred hyperlinks", () => {
    const hyperlink: Hyperlink = {
      type: "hyperlink",
      rId: "rId1",
      children: [],
    };
    const rels: RelationshipMap = new Map([
      [
        "rId1",
        {
          id: "rId1",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
          target: "https://example.com/matter",
          targetMode: "External",
        },
      ],
    ]);

    expect(resolveHyperlinkUrl(hyperlink, rels)).toBe(
      "https://example.com/matter",
    );
    expect(hyperlink.href).toBe("https://example.com/matter");
  });
});
