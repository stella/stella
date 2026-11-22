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

  test("render only the page, not other HTML parts, decoded in its own charset", async () => {
    const archive = new TextEncoder().encode(
      [
        "MIME-Version: 1.0",
        'Content-Type: multipart/related; boundary="b"',
        "",
        "--b",
        "Content-Type: text/html; charset=windows-1250",
        "Content-Transfer-Encoding: quoted-printable",
        "Content-Location: https://example.test/page.html",
        "",
        "<html><body><p>Smlouva o d=EDle</p></body></html>",
        "--b",
        "Content-Type: text/html; charset=utf-8",
        "Content-Location: https://example.test/frame.html",
        "",
        "<html><body><p>Frame resource</p></body></html>",
        "--b--",
        "",
      ].join("\r\n"),
    );
    const source = html(await webArchiveToHtml(archive));
    expect(source).toContain("Smlouva o díle");
    expect(source).not.toContain("Frame resource");
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

  test("render a chapter the spine repeats once, and an image referenced often within the budget", async () => {
    const references = '<img src="plate.png">'.repeat(2000);
    const source = html(
      await ebookToHtml(
        await ebookFile({
          chapters: [
            { file: "one.xhtml", body: `<h1>Only chapter</h1>${references}` },
          ],
          images: { "plate.png": PNG },
          spineOrder: ["one.xhtml", "one.xhtml", "one.xhtml"],
        }),
      ),
    );
    expect(source.split("Only chapter")).toHaveLength(2);
    expect(source.split(PNG_DATA_URI)).toHaveLength(2001);
  });

  test("fail, never skip, a chapter whose stored bytes are damaged", async () => {
    const book = await ebookFile({
      chapters: [
        { file: "one.xhtml", body: "<p>Intact chapter</p>" },
        { file: "two.xhtml", body: "<p>Damaged chapter</p>" },
      ],
    });
    const marker = new TextEncoder().encode("Damaged chapter");
    const at = Buffer.from(book).indexOf(Buffer.from(marker));
    expect(at).toBeGreaterThan(0);
    const damaged = book.slice();
    damaged[at] = 0x58;
    expect(Result.isError(await ebookToHtml(damaged))).toBe(true);
  });

  test("fail when the reading order names a chapter the manifest lacks", async () => {
    const book = await packageOf({
      mimetype: "application/epub+zip",
      "META-INF/container.xml":
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
      "content.opf":
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c0" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c0"/><itemref idref="missing"/><itemref idref="note" linear="no"/></spine></package>',
      "one.xhtml": "<html><body><p>Present</p></body></html>",
    });
    expect(Result.isError(await ebookToHtml(book))).toBe(true);
  });

  test("read UTF-16 chapters and images the manifest types without an extension", async () => {
    const chapter = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Dvojbajtová kapitola</p><img src="plate"/></body></html>',
        "utf16le",
      ),
    ]);
    const book = await packageOf({
      mimetype: "application/epub+zip",
      "META-INF/container.xml":
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
      "content.opf":
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c0" href="one.xhtml" media-type="application/xhtml+xml"/><item id="p" href="plate" media-type="image/png"/></manifest><spine><itemref idref="c0"/></spine></package>',
      "one.xhtml": new Uint8Array(chapter),
      plate: PNG,
    });
    const source = html(await ebookToHtml(book));
    expect(source).toContain("Dvojbajtová kapitola");
    expect(source).toContain(PNG_DATA_URI);
  });

  test("refuse a chapter declaring an encoding other than UTF-8", async () => {
    const book = await ebookFile({
      chapters: [{ file: "one.xhtml", body: "<p>x</p>" }],
    });
    const declared = await packageOf({
      mimetype: "application/epub+zip",
      "META-INF/container.xml":
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
      "content.opf":
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c0" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c0"/></spine></package>',
      "one.xhtml":
        '<?xml version="1.0" encoding="windows-1250"?><html><body><p>x</p></body></html>',
    });
    expect(Result.isOk(await ebookToHtml(book))).toBe(true);
    expect(Result.isError(await ebookToHtml(declared))).toBe(true);
  });

  test("refuse a package with no readable package document", async () => {
    const rendered = await ebookToHtml(
      await packageOf({ mimetype: "application/epub+zip" }),
    );
    expect(Result.isError(rendered)).toBe(true);
  });
});
