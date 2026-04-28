import { describe, expect, test } from "bun:test";

import type { Document } from "../../types/document";
import { toProseDoc } from "./toProseDoc";

describe("toProseDoc", () => {
  test("applies built-in Word Normal defaults when styles.xml is absent", () => {
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "Plain paragraph" }],
                },
              ],
            },
          ],
        },
      },
    };

    const doc = toProseDoc(document);
    const paragraph = doc.firstChild;

    expect(paragraph?.attrs.spaceAfter).toBe(160);
    expect(paragraph?.attrs.lineSpacing).toBe(259);
    expect(paragraph?.attrs.lineSpacingRule).toBe("auto");
  });
});
