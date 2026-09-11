import { describe, expect, test } from "bun:test";

import { withInferredCzechSignatureRoles } from "./czech-document-roles";
import type { Block } from "./document-ast";

const inlineText = (text: string) => [{ type: "text" as const, text }];

const paragraph = (id: string, plainText: string): Block => ({
  anchorId: id,
  id,
  inlines: inlineText(plainText),
  plainText,
  type: "paragraph",
});

const heading = (id: string, plainText: string): Block => ({
  anchorId: id,
  id,
  inlines: inlineText(plainText),
  level: 1,
  plainText,
  type: "heading",
});

describe("Czech legal-document signatures", () => {
  test("one signature role covers courts and other public authorities", () => {
    const refined = withInferredCzechSignatureRoles([
      paragraph("body", "Toto opatření nabývá účinnosti dnem vyhlášení."),
      heading("office-1", "Guvernér:"),
      heading("name", "v z. prof. Dr. Ing. Frait v. r."),
      heading("office-2", "viceguvernér"),
      paragraph("judge", "předseda senátu"),
    ]);

    expect(refined.at(0)).toEqual(
      paragraph("body", "Toto opatření nabývá účinnosti dnem vyhlášení."),
    );
    for (const block of refined.slice(1)) {
      expect(block.type).toBe("paragraph");
      expect(block.type === "paragraph" ? block.role : null).toBe("signature");
    }
  });
});
