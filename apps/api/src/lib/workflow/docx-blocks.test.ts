import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  renderDocxCommentMarkup,
  renderDocxDeletionMarkup,
  renderDocxInsertionMarkup,
} from "@/api/lib/docx-review-markup";
import {
  extractFolioBlocksFromDocxBuffer,
  extractFolioBlockTextFromDocxBuffer,
} from "@/api/lib/workflow/docx-blocks";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";

const buildDocxBuffer = async ({
  documentXml,
  footerXml,
  headerXml,
  commentsXml,
  commentsExtendedXml,
}: {
  documentXml: string;
  commentsExtendedXml?: string;
  commentsXml?: string;
  footerXml?: string;
  headerXml?: string;
}): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  if (headerXml) {
    zip.file("word/header1.xml", headerXml);
  }
  if (footerXml) {
    zip.file("word/footer1.xml", footerXml);
  }
  if (commentsXml) {
    zip.file("word/comments.xml", commentsXml);
  }
  if (commentsExtendedXml) {
    zip.file("word/commentsExtended.xml", commentsExtendedXml);
  }
  const bytes = await zip.generateAsync({ type: "uint8array" });
  // Copy into a fresh ArrayBuffer so the result is plain (not
  // SharedArrayBuffer-typed) and detached from the source.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
};

const wrap = (
  body: string,
) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:mc="${MC_NS}">
  <w:body>${body}</w:body>
</w:document>`;

const wrapHeader = (
  body: string,
) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W_NS}" xmlns:mc="${MC_NS}">
  ${body}
</w:hdr>`;

const wrapFooter = (
  body: string,
) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="${W_NS}" xmlns:mc="${MC_NS}">
  ${body}
</w:ftr>`;

const wrapComments = (
  comments: string,
) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${W_NS}" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  ${comments}
</w:comments>`;

const wrapCommentsExtended = (
  comments: string,
) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  ${comments}
</w15:commentsEx>`;

describe("extractFolioBlocksFromDocxBuffer", () => {
  test("preserves tracked changes as inline review tags", async () => {
    const buffer = await buildDocxBuffer({
      documentXml: wrap(`
        <w:p>
          <w:r><w:t>Kept </w:t></w:r>
          <w:moveFrom>
            <w:r><w:t>OLD</w:t></w:r>
          </w:moveFrom>
          <w:moveTo>
            <w:r><w:t>NEW</w:t></w:r>
          </w:moveTo>
          <w:del w:author="Jane Doe" w:initials="JD" w:date="2026-05-07T12:00:00Z">
            <w:r><w:delText>DELETED</w:delText></w:r>
          </w:del>
          <w:ins w:author="Jan Novak" w:initials="JN" w:date="2026-05-08T09:30:00Z">
            <w:r><w:t> inserted</w:t></w:r>
          </w:ins>
        </w:p>
      `),
    });

    const blocks = await extractFolioBlocksFromDocxBuffer(buffer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(
      [
        "Kept ",
        renderDocxDeletionMarkup({ text: "OLD" }),
        renderDocxInsertionMarkup({ text: "NEW" }),
        renderDocxDeletionMarkup({
          metadata: {
            author: "Jane Doe",
            date: "2026-05-07T12:00:00Z",
            initials: "JD",
          },
          text: "DELETED",
        }),
        renderDocxInsertionMarkup({
          metadata: {
            author: "Jan Novak",
            date: "2026-05-08T09:30:00Z",
            initials: "JN",
          },
          text: " inserted",
        }),
      ].join(""),
    );
  });

  // Regression for PR #56 review feedback: only one branch of
  // `w:alternateContent` should contribute. Visiting both branches
  // would emit the same paragraph text twice for compatibility-
  // wrapped content (e.g. drawings with a fallback shape).
  test("emits the alternateContent choice branch only", async () => {
    const buffer = await buildDocxBuffer({
      documentXml: wrap(`
        <w:p>
          <mc:AlternateContent>
            <mc:Choice Requires="w14">
              <w:r><w:t>preferred</w:t></w:r>
            </mc:Choice>
            <mc:Fallback>
              <w:r><w:t>legacy</w:t></w:r>
            </mc:Fallback>
          </mc:AlternateContent>
        </w:p>
      `),
    });

    const blocks = await extractFolioBlocksFromDocxBuffer(buffer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("preferred");
  });

  test("keeps ordinary special characters readable in body text", async () => {
    const buffer = await buildDocxBuffer({
      documentXml: wrap(`
        <w:p>
          <w:r><w:t>AT&amp;T covenant: 5 &lt; 10 &gt; 3</w:t></w:r>
        </w:p>
      `),
    });

    const blocks = await extractFolioBlocksFromDocxBuffer(buffer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("AT&T covenant: 5 < 10 > 3");
  });

  test("surfaces comment bubbles at their anchor", async () => {
    const buffer = await buildDocxBuffer({
      documentXml: wrap(`
        <w:p>
          <w:r><w:t>Payment is due </w:t></w:r>
          <w:commentRangeStart w:id="7"/>
          <w:r><w:t>within 30 days</w:t></w:r>
          <w:commentRangeEnd w:id="7"/>
        </w:p>
      `),
      commentsXml: wrapComments(`
        <w:comment w:id="7" w:author="Reviewer">
          <w:p><w:r><w:t>Confirm this timing with finance.</w:t></w:r></w:p>
        </w:comment>
      `),
    });

    const blocks = await extractFolioBlocksFromDocxBuffer(buffer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(
      [
        "Payment is due ",
        renderDocxCommentMarkup({
          metadata: {
            author: "Reviewer",
          },
          text: "Confirm this timing with finance.",
        }),
        "within 30 days",
      ].join(""),
    );
  });

  test("surfaces point-only comment references", async () => {
    const buffer = await buildDocxBuffer({
      commentsXml: wrapComments(`
        <w:comment w:id="42" w:author="Reviewer">
          <w:p><w:r><w:t>Check defined term.</w:t></w:r></w:p>
        </w:comment>
      `),
      documentXml: wrap(`
        <w:p>
          <w:r><w:t>Commented text</w:t></w:r>
          <w:r>
            <w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>
            <w:commentReference w:id="42"/>
          </w:r>
        </w:p>
      `),
    });

    const blocks = await extractFolioBlocksFromDocxBuffer(buffer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(
      [
        "Commented text",
        renderDocxCommentMarkup({
          metadata: {
            author: "Reviewer",
          },
          text: "Check defined term.",
        }),
      ].join(""),
    );
  });

  test("does not duplicate ranged comments that also have a reference marker", async () => {
    const buffer = await buildDocxBuffer({
      commentsXml: wrapComments(`
        <w:comment w:id="9" w:author="Reviewer">
          <w:p><w:r><w:t>Confirm grace period.</w:t></w:r></w:p>
        </w:comment>
      `),
      documentXml: wrap(`
        <w:p>
          <w:r><w:t>Payment </w:t></w:r>
          <w:commentRangeStart w:id="9"/>
          <w:r><w:t>grace period</w:t></w:r>
          <w:commentRangeEnd w:id="9"/>
          <w:r>
            <w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>
            <w:commentReference w:id="9"/>
          </w:r>
        </w:p>
      `),
    });

    const blocks = await extractFolioBlocksFromDocxBuffer(buffer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(
      [
        "Payment ",
        renderDocxCommentMarkup({
          metadata: {
            author: "Reviewer",
          },
          text: "Confirm grace period.",
        }),
        "grace period",
      ].join(""),
    );
  });

  test("does not duplicate multi-paragraph ranged comments at the reference marker", async () => {
    const buffer = await buildDocxBuffer({
      commentsXml: wrapComments(`
        <w:comment w:id="17" w:author="Reviewer">
          <w:p><w:r><w:t>Review both paragraphs.</w:t></w:r></w:p>
        </w:comment>
      `),
      documentXml: wrap(`
        <w:p>
          <w:commentRangeStart w:id="17"/>
          <w:r><w:t>First paragraph</w:t></w:r>
        </w:p>
        <w:p>
          <w:r><w:t>Second paragraph</w:t></w:r>
          <w:commentRangeEnd w:id="17"/>
          <w:r>
            <w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>
            <w:commentReference w:id="17"/>
          </w:r>
        </w:p>
      `),
    });

    const text = await extractFolioBlockTextFromDocxBuffer(buffer);

    expect(text).toBe(
      [
        renderDocxCommentMarkup({
          metadata: {
            author: "Reviewer",
          },
          text: "Review both paragraphs.",
        }),
        "First paragraph\nSecond paragraph",
      ].join(""),
    );
  });

  test("preserves comments nested inside tracked changes", async () => {
    const buffer = await buildDocxBuffer({
      commentsXml: wrapComments(`
        <w:comment w:id="13" w:author="Reviewer">
          <w:p><w:r><w:t>Check inserted obligation.</w:t></w:r></w:p>
        </w:comment>
      `),
      documentXml: wrap(`
        <w:p>
          <w:r><w:t>Clause </w:t></w:r>
          <w:ins w:author="Jane Doe" w:initials="JD" w:date="2026-05-07T12:00:00Z">
            <w:commentRangeStart w:id="13"/>
            <w:r><w:t>new obligation</w:t></w:r>
            <w:commentRangeEnd w:id="13"/>
            <w:r><w:commentReference w:id="13"/></w:r>
          </w:ins>
        </w:p>
      `),
    });

    const blocks = await extractFolioBlocksFromDocxBuffer(buffer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(
      [
        "Clause ",
        renderDocxInsertionMarkup({
          contentKind: "markup",
          metadata: {
            author: "Jane Doe",
            date: "2026-05-07T12:00:00Z",
            initials: "JD",
          },
          text: [
            renderDocxCommentMarkup({
              metadata: {
                author: "Reviewer",
              },
              text: "Check inserted obligation.",
            }),
            "new obligation",
          ].join(""),
        }),
      ].join(""),
    );
  });

  test("preserves move range markers as review tags", async () => {
    const buffer = await buildDocxBuffer({
      documentXml: wrap(`
        <w:p>
          <w:r><w:t>Clause </w:t></w:r>
          <w:moveFromRangeStart w:id="5" w:author="Mover" w:initials="MV" w:date="2026-05-07T08:00:00Z"/>
          <w:r><w:t>old position</w:t></w:r>
          <w:moveFromRangeEnd w:id="5"/>
          <w:r><w:t> </w:t></w:r>
          <w:moveToRangeStart w:id="6" w:author="Mover" w:initials="MV" w:date="2026-05-07T08:05:00Z"/>
          <w:r><w:t>new position</w:t></w:r>
          <w:moveToRangeEnd w:id="6"/>
        </w:p>
      `),
    });

    const blocks = await extractFolioBlocksFromDocxBuffer(buffer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(
      [
        "Clause ",
        renderDocxDeletionMarkup({
          metadata: {
            author: "Mover",
            date: "2026-05-07T08:00:00Z",
            initials: "MV",
          },
          text: "old position",
        }),
        " ",
        renderDocxInsertionMarkup({
          metadata: {
            author: "Mover",
            date: "2026-05-07T08:05:00Z",
            initials: "MV",
          },
          text: "new position",
        }),
      ].join(""),
    );
  });

  test("preserves move range markers across paragraphs", async () => {
    const buffer = await buildDocxBuffer({
      documentXml: wrap(`
        <w:p>
          <w:moveFromRangeStart w:id="7"/>
          <w:r><w:t>old first paragraph</w:t></w:r>
        </w:p>
        <w:p>
          <w:r><w:t>old second paragraph</w:t></w:r>
          <w:moveFromRangeEnd w:id="7"/>
          <w:r><w:t> current</w:t></w:r>
        </w:p>
      `),
    });

    const text = await extractFolioBlockTextFromDocxBuffer(buffer);

    expect(text).toBe(
      [
        renderDocxDeletionMarkup({ text: "old first paragraph" }),
        "\n",
        renderDocxDeletionMarkup({ text: "old second paragraph" }),
        " current",
      ].join(""),
    );
  });

  test("extracts redline-aware text from the same block source", async () => {
    const buffer = await buildDocxBuffer({
      documentXml: wrap(`
        <w:p><w:r><w:t>First</w:t></w:r></w:p>
        <w:p>
          <w:r><w:t>Second </w:t></w:r>
          <w:del><w:r><w:delText>old</w:delText></w:r></w:del>
          <w:ins><w:r><w:t>new</w:t></w:r></w:ins>
        </w:p>
      `),
    });

    const text = await extractFolioBlockTextFromDocxBuffer(buffer);

    expect(text).toBe(
      [
        "First\nSecond ",
        renderDocxDeletionMarkup({ text: "old" }),
        renderDocxInsertionMarkup({ text: "new" }),
      ].join(""),
    );
  });

  test("includes header and footer text in plain text extraction", async () => {
    const buffer = await buildDocxBuffer({
      documentXml: wrap(`
        <w:p><w:r><w:t>Body text</w:t></w:r></w:p>
      `),
      footerXml: wrapFooter(`
        <w:p><w:r><w:t>Footer text</w:t></w:r></w:p>
      `),
      headerXml: wrapHeader(`
        <w:p><w:r><w:t>Header text</w:t></w:r></w:p>
      `),
    });

    const text = await extractFolioBlockTextFromDocxBuffer(buffer);

    expect(text).toBe("Header text\nBody text\nFooter text");
  });

  test("surfaces comment author initials date and resolved thread metadata", async () => {
    const buffer = await buildDocxBuffer({
      commentsExtendedXml: wrapCommentsExtended(`
        <w15:commentEx w15:paraId="00ABCDEF" w15:done="1" />
      `),
      commentsXml: wrapComments(`
        <w:comment w:id="12" w:author="Reviewer" w:initials="RV" w:date="2026-05-09T13:45:00Z">
          <w:p w15:paraId="00ABCDEF">
            <w:r><w:t>Resolve after signing.</w:t></w:r>
          </w:p>
        </w:comment>
      `),
      documentXml: wrap(`
        <w:p>
          <w:r><w:t>Signature pages </w:t></w:r>
          <w:commentRangeStart w:id="12"/>
          <w:r><w:t>to follow</w:t></w:r>
        </w:p>
      `),
    });

    const blocks = await extractFolioBlocksFromDocxBuffer(buffer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(
      [
        "Signature pages ",
        renderDocxCommentMarkup({
          metadata: {
            author: "Reviewer",
            date: "2026-05-09T13:45:00Z",
            initials: "RV",
            status: "resolved",
            thread: "root",
          },
          text: "Resolve after signing.",
        }),
        "to follow",
      ].join(""),
    );
  });

  test("preserves paragraph separators inside comment text", async () => {
    const buffer = await buildDocxBuffer({
      commentsXml: wrapComments(`
        <w:comment w:id="21" w:author="Reviewer">
          <w:p><w:r><w:t>First sentence.</w:t></w:r></w:p>
          <w:p><w:r><w:t>Second sentence.</w:t></w:r></w:p>
        </w:comment>
      `),
      documentXml: wrap(`
        <w:p>
          <w:r><w:t>Clause </w:t></w:r>
          <w:commentRangeStart w:id="21"/>
          <w:r><w:t>text</w:t></w:r>
        </w:p>
      `),
    });

    const blocks = await extractFolioBlocksFromDocxBuffer(buffer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(
      [
        "Clause ",
        renderDocxCommentMarkup({
          metadata: {
            author: "Reviewer",
          },
          text: "First sentence. Second sentence.",
        }),
        "text",
      ].join(""),
    );
  });
});
