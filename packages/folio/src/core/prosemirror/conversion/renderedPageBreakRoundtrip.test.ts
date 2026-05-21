import { describe, expect, test } from "bun:test";

import { serializeParagraph } from "../../docx/serializer/paragraphSerializer";
import { schema } from "../schema";
import { fromProseDoc } from "./fromProseDoc";

describe("renderedPageBreakBefore round-trip", () => {
  test("attr survives PM to Document to XML", () => {
    const paragraph = schema.node(
      "paragraph",
      { renderedPageBreakBefore: true },
      [schema.text("Attachment 1")],
    );
    const doc = schema.node("doc", null, [paragraph]);

    const document = fromProseDoc(doc);
    const parsed = document.package.document.content[0] as {
      renderedPageBreakBefore?: boolean;
    };
    expect(parsed.renderedPageBreakBefore).toBe(true);

    const xml = serializeParagraph(parsed as never);
    expect(xml).toMatch(/<w:lastRenderedPageBreak\/>/u);
    expect(xml).toMatch(/<w:r[^>]*><w:lastRenderedPageBreak\/>/u);
  });

  test("serializer injects marker into the first run inside a hyperlink wrapper", () => {
    const paragraph = {
      type: "paragraph" as const,
      renderedPageBreakBefore: true,
      content: [
        {
          type: "hyperlink" as const,
          href: "https://example.com",
          children: [
            {
              type: "run" as const,
              content: [{ type: "text" as const, text: "link" }],
            },
          ],
        },
      ],
    };

    const xml = serializeParagraph(paragraph as never);
    expect(xml).toMatch(
      /<w:hyperlink[^>]*>[^<]*<w:r[^>]*><w:lastRenderedPageBreak\/>/u,
    );
  });
});
