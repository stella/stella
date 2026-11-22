import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { contentMatchesConvertibleMime } from "@/api/lib/files/conversion-content";
import { checkConversionInput } from "@/api/lib/files/conversion-input";
import { ebookToHtml } from "@/api/lib/files/epub-document";
import { webArchiveToHtml } from "@/api/lib/files/mhtml-document";
import {
  ebookFile,
  packageOf,
  webArchiveFile,
} from "@/api/tests/helpers/converted-document-fixtures";
import { splitPng } from "@/api/tests/helpers/image-fixtures";

const PNG = splitPng(4, 4);
const PNG_DATA_URI = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

const html = (rendered: Result<Uint8Array, unknown>): string => {
  if (Result.isError(rendered)) {
    throw rendered.error;
  }
  return new TextDecoder().decode(rendered.value);
};

/** The rendered HTML converts under the same checks as an uploaded HTML file. */
const expectConvertibleHtml = async (source: string) => {
  const bytes = new TextEncoder().encode(source);
  expect(await checkConversionInput("text/html", bytes)).toEqual({
    kind: "convert",
  });
  expect(await contentMatchesConvertibleMime("text/html", bytes)).toBe(true);
};

describe("web archives", () => {
  test("embed the images the archive carries, by location or content id", async () => {
    const source = html(
      await webArchiveToHtml(
        webArchiveFile({
          body: '<h1>Synthetic notice</h1><img src="logo.png"><img src="https://example.test/notice/seal.png"><img src="cid:sig@archive">',
          images: [
            {
              location: "https://example.test/notice/logo.png",
              type: "image/png",
              bytes: PNG,
            },
            {
              location: "https://example.test/notice/seal.png",
              type: "image/png",
              bytes: PNG,
            },
            { contentId: "sig@archive", type: "image/png", bytes: PNG },
          ],
        }),
      ),
    );
    expect(source).toContain("Synthetic notice");
    expect(source.split(PNG_DATA_URI)).toHaveLength(4);
    await expectConvertibleHtml(source);
  });

  test("drop every reference outside the archive, and active content", async () => {
    const source = html(
      await webArchiveToHtml(
        webArchiveFile({
          body: '<p>Kept text</p><img src="https://elsewhere.test/pixel.png"><script>alert(1)</script><link rel="stylesheet" href="https://elsewhere.test/a.css"><iframe src="https://elsewhere.test/"></iframe><p style="background:url(https://elsewhere.test/b.png)">Styled</p>',
        }),
      ),
    );
    expect(source).toContain("Kept text");
    expect(source).not.toContain("elsewhere.test");
    expect(source).not.toContain("<script");
    await expectConvertibleHtml(source);
  });

  test("refuse a message with no page", async () => {
    const rendered = await webArchiveToHtml(
      new TextEncoder().encode(
        "MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nOnly text\r\n",
      ),
    );
    expect(Result.isError(rendered)).toBe(true);
  });
});

describe("e-books", () => {
  test("render the spine's chapters in reading order with their images", async () => {
    const source = html(
      await ebookToHtml(
        await ebookFile({
          chapters: [
            { file: "text/b.xhtml", body: "<h1>Second chapter</h1>" },
            {
              file: "text/a.xhtml",
              body: '<h1>First chapter</h1><img src="../images/plate.png" alt="Plate">',
            },
          ],
          images: { "images/plate.png": PNG },
          spineOrder: ["text/a.xhtml", "text/b.xhtml"],
        }),
      ),
    );
    expect(source.indexOf("First chapter")).toBeLessThan(
      source.indexOf("Second chapter"),
    );
    expect(source).toContain(PNG_DATA_URI);
    expect(source).not.toContain("style.css");
    await expectConvertibleHtml(source);
  });

  test("keep an image drawn through SVG, and drop references that leave the book", async () => {
    const source = html(
      await ebookToHtml(
        await ebookFile({
          chapters: [
            {
              file: "cover.xhtml",
              body: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="cover.png"/></svg><p>Cover</p><img src="../../outside.png"><img src="https://elsewhere.test/a.png">',
            },
          ],
          images: { "cover.png": PNG },
        }),
      ),
    );
    expect(source).toContain(PNG_DATA_URI);
    expect(source).not.toContain("<svg");
    expect(source).not.toContain("outside.png");
    expect(source).not.toContain("elsewhere.test");
    await expectConvertibleHtml(source);
  });

  test("refuse a package with no readable package document", async () => {
    const rendered = await ebookToHtml(
      await packageOf({ mimetype: "application/epub+zip" }),
    );
    expect(Result.isError(rendered)).toBe(true);
  });
});
