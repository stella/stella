import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { readImageHeader } from "@/api/lib/files/image-header";
import { previewText, renderPdf } from "@/api/lib/files/pdf-render";
import { loadStampFonts } from "@/api/lib/files/pdf-signing/stamp-font";
import { openPdfiumDocument } from "@/api/lib/files/pdfium";
import {
  csvToPdf,
  plainTextToPdf,
  PREVIEW_SHORTENED_NOTE,
} from "@/api/lib/files/text-preview-pdf";
import { readTiffPages } from "@/api/lib/files/tiff-pages";
import { LIMITS } from "@/api/lib/limits";
import {
  declaredPng,
  heicFixture,
  splitBmp,
  splitGif,
  splitJpeg,
  splitPng,
  splitTiffPage,
  splitWebp,
  tiffFile,
  withHeifRotation,
} from "@/api/tests/helpers/image-fixtures";

/** The first index of `needle` in `haystack`, or -1. */
const indexOfBytes = (haystack: Uint8Array, needle: Uint8Array) => {
  for (let index = 0; index + needle.length <= haystack.length; index += 1) {
    if (needle.every((byte, offset) => haystack[index + offset] === byte)) {
      return index;
    }
  }
  return -1;
};

type RenderedPage = {
  width: number;
  height: number;
  /** RGB at a fractional position, top-left origin. */
  colorAt: (fx: number, fy: number) => readonly [number, number, number];
};

/** Every page of `pdf`, rendered at one pixel per point. */
const renderPages = async (pdf: Uint8Array): Promise<RenderedPage[]> => {
  const document = (await openPdfiumDocument(pdf)).unwrap();
  const pages: RenderedPage[] = [];
  for (let index = 0; index < document.pageCount; index += 1) {
    const { pointHeight, pointWidth } = document.pageSize(index).unwrap();
    const width = Math.max(1, Math.floor(pointWidth));
    const height = Math.max(1, Math.floor(pointHeight));
    const { rgba } = document.renderPage({ height, index, width }).unwrap();
    pages.push({
      colorAt: (fx, fy) => {
        const offset =
          (Math.floor(height * fy) * width + Math.floor(width * fx)) * 4;
        return [
          rgba[offset] ?? 0,
          rgba[offset + 1] ?? 0,
          rgba[offset + 2] ?? 0,
        ];
      },
      height: pointHeight,
      width: pointWidth,
    });
  }
  document.close();
  return pages;
};

const isRed = ([r, g, b]: readonly [number, number, number]) =>
  r > 200 && g < 60 && b < 60;
const isBlue = ([r, g, b]: readonly [number, number, number]) =>
  b > 200 && r < 60 && g < 60;

const rendered = async (mimeType: string, bytes: Uint8Array) => {
  const result = await renderPdf(mimeType, bytes);
  if (Result.isError(result)) {
    throw result.error;
  }
  if (result.value.type === "too-large") {
    throw new Error(`${mimeType} rendered too large`);
  }
  return result.value.bytes;
};

/** A 64 x 32 px image is 48 x 24 pt at 96 px per inch. */
const SPLIT = { width: 48, height: 24 } as const;

/** Left half red, right half blue, as stored. */
const expectSplit = (page: RenderedPage | undefined) => {
  expect(page?.width).toBeCloseTo(SPLIT.width, 3);
  expect(page?.height).toBeCloseTo(SPLIT.height, 3);
  expect(isRed(page?.colorAt(0.25, 0.5) ?? [0, 0, 0])).toBe(true);
  expect(isBlue(page?.colorAt(0.75, 0.5) ?? [0, 0, 0])).toBe(true);
};

describe("images rendered in-process", () => {
  test.each([
    ["image/bmp", () => splitBmp(64, 32)],
    ["image/gif", () => splitGif(64, 32)],
    ["image/png", () => splitPng(64, 32)],
    ["image/webp", async () => await splitWebp(64, 32)],
  ] as const)(
    "a %s becomes one page sized to the image",
    async (mimeType, build) => {
      const pages = await renderPages(await rendered(mimeType, await build()));
      expect(pages).toHaveLength(1);
      expectSplit(pages[0]);
    },
  );

  test("a GIF shows its first frame only", async () => {
    const gif = splitGif(64, 32, 3);
    const pages = await renderPages(await rendered("image/gif", gif));
    expect(pages).toHaveLength(1);
    // Later frames are solid blue; the first is split.
    expectSplit(pages[0]);
  });

  test("a rotated EXIF JPEG is shown upright", async () => {
    // Stored 64 x 32, red | blue; orientation 6 turns it a quarter clockwise,
    // so the page is 24 x 48 with red on top.
    const jpeg = await splitJpeg(64, 32, 6);
    expect(readImageHeader(jpeg, "image/jpeg")?.orientation).toBe(6);
    const [page] = await renderPages(await rendered("image/jpeg", jpeg));
    expect(page?.width).toBeCloseTo(24, 3);
    expect(page?.height).toBeCloseTo(48, 3);
    expect(isRed(page?.colorAt(0.5, 0.25) ?? [0, 0, 0])).toBe(true);
    expect(isBlue(page?.colorAt(0.5, 0.75) ?? [0, 0, 0])).toBe(true);
  });

  test("every page of a TIFF is its own page, each with its orientation", async () => {
    const tiff = tiffFile([
      splitTiffPage(64, 32),
      splitTiffPage(64, 32, 6),
      {
        width: 32,
        height: 32,
        pixel: () => [0, 0, 255],
      },
    ]);
    expect(readImageHeader(tiff, "image/tiff")).toMatchObject({
      width: 64,
      height: 32,
    });
    const pages = await renderPages(await rendered("image/tiff", tiff));
    expect(pages).toHaveLength(3);
    expectSplit(pages[0]);
    expect(pages[1]?.width).toBeCloseTo(24, 3);
    expect(pages[1]?.height).toBeCloseTo(48, 3);
    expect(isRed(pages[1]?.colorAt(0.5, 0.25) ?? [0, 0, 0])).toBe(true);
    expect(isBlue(pages[1]?.colorAt(0.5, 0.75) ?? [0, 0, 0])).toBe(true);
    expect(pages[2]?.width).toBeCloseTo(24, 3);
    expect(isBlue(pages[2]?.colorAt(0.5, 0.5) ?? [0, 0, 0])).toBe(true);
  });

  test("a TIFF whose strip runs past the end of the file is refused", async () => {
    const tiff = tiffFile([splitTiffPage(64, 32)]);
    expect(Result.isOk(await renderPdf("image/tiff", tiff))).toBe(true);
    // The directory stays readable; only its StripOffsets value (tag 273,
    // LONG, one value) moves so the strip's bytes would end past the file.
    const entry = indexOfBytes(
      tiff,
      Uint8Array.from([0x11, 0x01, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00]),
    );
    expect(entry).toBeGreaterThan(0);
    const cut = tiff.slice();
    new DataView(cut.buffer).setUint32(entry + 8, tiff.length - 16, true);
    expect(Result.isError(await renderPdf("image/tiff", cut))).toBe(true);
  });

  test("a CMYK TIFF renders in colour", async () => {
    const tiff = tiffFile([
      {
        width: 64,
        height: 32,
        cmyk: true,
        // Magenta and yellow make red; cyan and magenta make blue.
        pixel: (x) => (x < 32 ? [0, 255, 255, 0] : [255, 255, 0, 0]),
      },
    ]);
    const pages = await renderPages(await rendered("image/tiff", tiff));
    expect(pages).toHaveLength(1);
    expectSplit(pages[0]);
  });

  test("a HEIC photo becomes one page sized to the photo", async () => {
    // 1100 x 700 px in 3 x 2 tiles is 825 x 525 pt.
    const pages = await renderPages(
      await rendered("image/heic", heicFixture("grid.heic")),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]?.width).toBeCloseTo(825, 3);
    expect(pages[0]?.height).toBeCloseTo(525, 3);
  });

  test("a rotated HEIC photo is shown upright", async () => {
    const turned = withHeifRotation(heicFixture("grid.heic"), 1);
    expect(readImageHeader(turned, "image/heic")?.orientation).toBe(8);
    const [page] = await renderPages(await rendered("image/heic", turned));
    expect(page?.width).toBeCloseTo(525, 3);
    expect(page?.height).toBeCloseTo(825, 3);
  });

  test("a HEIC photo declaring more than the decode budget is too large", async () => {
    const huge = heicFixture("grid.heic");
    // The grid's ispe (version and flags, then 1100 and 700) declares
    // 20000 x 20000 instead; the tiles are untouched.
    const ispe = indexOfBytes(
      huge,
      Uint8Array.from([
        ...new TextEncoder().encode("ispe"),
        ...[0, 0, 0, 0, 0, 0, 0x04, 0x4c, 0, 0, 0x02, 0xbc],
      ]),
    );
    expect(ispe).toBeGreaterThan(0);
    const view = new DataView(huge.buffer, huge.byteOffset);
    view.setUint32(ispe + 8, 20_000);
    view.setUint32(ispe + 12, 20_000);
    const result = await renderPdf("image/heic", huge);
    expect(Result.isOk(result) && result.value.type).toBe("too-large");
  });

  test("a HEIC file whose pictures are cut off is refused", async () => {
    const cut = heicFixture("grid.heic").subarray(0, 3000);
    expect(Result.isError(await renderPdf("image/heic", cut))).toBe(true);
  });

  test("an image whose bitstream is garbage is refused", async () => {
    const corrupt = splitBmp(64, 32);
    // A BMP header declaring a compression the decoder has no codec for.
    new DataView(corrupt.buffer).setUint32(30, 99, true);
    const result = await renderPdf("image/bmp", corrupt);
    expect(Result.isError(result)).toBe(true);
  });
});

type TextItem = {
  text: string;
  x: number;
  y: number;
  width: number;
  page: number;
};

/** The text pdf.js reads from each page, with where each item starts. */
const textItems = async (pdf: Uint8Array) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdfjs.getDocument({ data: pdf.slice(), verbosity: 0 });
  const document = await loading.promise;
  const items: TextItem[] = [];
  const pageWidths: number[] = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    pageWidths.push(page.view[2] ?? 0);
    for (const item of (await page.getTextContent()).items) {
      if ("str" in item && item.str.trim() !== "") {
        items.push({
          page: index,
          text: item.str,
          width: item.width,
          x: Number(item.transform[4]),
          y: Number(item.transform[5]),
        });
      }
    }
  }
  await loading.destroy();
  return { items, pageCount: document.numPages, pageWidths };
};

const CZECH = "Příliš žluťoučký kůň úpěl ďábelské ódy.";
const ARABIC = "هذا نص عربي للتجربة";
const CHINESE = "这是用于测试的中文文本";

/** Whether `items` read back `expected`, ignoring how pdf.js splits them. */
const readsBack = (items: readonly TextItem[], expected: string) =>
  items
    .map(({ text }) => text)
    .join("")
    .replaceAll(/\s+/gu, "")
    .includes(expected.replaceAll(/\s+/gu, ""));

describe("plain text rendered in-process", () => {
  test("Czech, Arabic and Chinese lines read back as their text", async () => {
    const text = [CZECH, ARABIC, CHINESE].join("\n");
    const { items, pageCount } = await textItems(
      await rendered("text/plain", new TextEncoder().encode(text)),
    );
    expect(pageCount).toBe(1);
    expect(readsBack(items, CZECH)).toBe(true);
    expect(readsBack(items, CHINESE)).toBe(true);
    // Arabic is drawn right to left: whatever order pdf.js reports the
    // words in, every word is there.
    for (const word of ARABIC.split(" ")) {
      expect(items.some(({ text: item }) => item.includes(word))).toBe(true);
    }
  });

  test("an Arabic line aligns right, a Czech line left", async () => {
    const { items, pageWidths } = await textItems(
      await rendered(
        "text/plain",
        new TextEncoder().encode(`${CZECH}\n${ARABIC}`),
      ),
    );
    const pageWidth = pageWidths[0] ?? 0;
    const czech = items.find(({ text }) => text.includes("Příliš"));
    const arabic = items.filter(({ text }) => /\p{Script=Arabic}/u.test(text));
    expect(czech?.x).toBeLessThan(pageWidth / 4);
    expect(arabic.length).toBeGreaterThan(0);
    const rightEdge = Math.max(...arabic.map(({ width, x }) => x + width));
    expect(rightEdge).toBeGreaterThan(pageWidth * 0.85);
  });

  test("long text wraps inside the margins and paginates", async () => {
    const paragraph = Array.from({ length: 60 }, () => CZECH).join(" ");
    const text = Array.from({ length: 40 }, () => paragraph).join("\n");
    const { items, pageCount, pageWidths } = await textItems(
      await rendered("text/plain", new TextEncoder().encode(text)),
    );
    expect(pageCount).toBeGreaterThan(5);
    const pageWidth = pageWidths[0] ?? 0;
    for (const { width, x } of items) {
      expect(x).toBeGreaterThanOrEqual(56);
      expect(x + width).toBeLessThanOrEqual(pageWidth - 56 + 1);
    }
  });

  test("Chinese without spaces wraps between characters", async () => {
    const text = CHINESE.repeat(40);
    const { items, pageWidths } = await textItems(
      await rendered("text/plain", new TextEncoder().encode(text)),
    );
    const pageWidth = pageWidths[0] ?? 0;
    expect(items.length).toBeGreaterThan(1);
    for (const { width, x } of items) {
      expect(x + width).toBeLessThanOrEqual(pageWidth - 56 + 1);
    }
    expect(readsBack(items, CHINESE.repeat(40))).toBe(true);
  });

  test("Chinese after a Latin word fills the first line instead of moving down", async () => {
    const { items } = await textItems(
      await rendered(
        "text/plain",
        new TextEncoder().encode(`Smlouva ${CHINESE.repeat(40)}`),
      ),
    );
    const latin = items.find(({ text }) => text.includes("Smlouva"));
    expect(latin).toBeDefined();
    expect(
      items.some(
        ({ text, y }) => y === latin?.y && /\p{Script=Han}/u.test(text),
      ),
    ).toBe(true);
  });

  test("a form feed starts a new page", async () => {
    const { items, pageCount } = await textItems(
      await rendered(
        "text/plain",
        new TextEncoder().encode("first page\fsecond page"),
      ),
    );
    expect(pageCount).toBe(2);
    expect(items.find(({ text }) => text.includes("second"))?.page).toBe(2);
  });

  test("a declared charset decodes the bytes", async () => {
    // "Žluťoučký" in windows-1250.
    const bytes = Uint8Array.from([
      0x8e, 0x6c, 0x75, 0x9d, 0x6f, 0x75, 0xe8, 0x6b, 0xfd,
    ]);
    const { items } = await textItems(
      await rendered("text/plain; charset=windows-1250", bytes),
    );
    expect(readsBack(items, "Žluťoučký")).toBe(true);
  });

  test("an empty file is one blank page", async () => {
    const { items, pageCount } = await textItems(
      await rendered("text/plain", new Uint8Array()),
    );
    expect(pageCount).toBe(1);
    expect(items).toEqual([]);
  });

  test("a replaced character keeps the direction it has in the file", async () => {
    // Cuneiform reads left to right and no face draws it; the Arabic after
    // it must not turn the line into a right-to-left one.
    const { items } = await textItems(
      await rendered(
        "text/plain",
        new TextEncoder().encode(`\u{12000} ${ARABIC}`),
      ),
    );
    expect(Math.min(...items.map(({ x }) => x))).toBeLessThan(100);
  });

  test("a character no font has shows as a replacement mark", async () => {
    // Cuneiform: no shipped face covers it.
    const { items } = await textItems(
      await rendered("text/plain", new TextEncoder().encode("a \u{12000} b")),
    );
    expect(readsBack(items, "a\uFFFDb")).toBe(true);
  });
});

describe("CSV rendered in-process", () => {
  const HEADER = ["Číslo", "Název", "Částka"];
  const csv = (rows: number, delimiter = ",") =>
    [
      HEADER.join(delimiter),
      ...Array.from({ length: rows }, (_, index) =>
        [String(index + 1), `Položka ${index + 1}`, `${index * 10},00`]
          .map((cell) => (cell.includes(delimiter) ? `"${cell}"` : cell))
          .join(delimiter),
      ),
    ].join("\r\n");

  test("a long table repeats its header row on every page", async () => {
    const { items, pageCount } = await textItems(
      await rendered("text/csv", new TextEncoder().encode(csv(200))),
    );
    expect(pageCount).toBeGreaterThan(2);
    for (let page = 1; page <= pageCount; page += 1) {
      const onPage = items.filter((item) => item.page === page);
      for (const header of HEADER) {
        expect(onPage.some(({ text }) => text === header)).toBe(true);
      }
    }
    // Every record is there once.
    for (const index of [1, 100, 200]) {
      expect(
        items.filter(({ text }) => text === `Položka ${index}`),
      ).toHaveLength(1);
    }
  });

  test("a quoted cell keeps its delimiter, and columns stay apart", async () => {
    const { items } = await textItems(
      await rendered("text/csv", new TextEncoder().encode(csv(3))),
    );
    const name = items.find(({ text }) => text === "Položka 2");
    const amount = items.find(({ text }) => text === "10,00");
    expect(name).toBeDefined();
    expect(amount).toBeDefined();
    expect((amount?.x ?? 0) > (name?.x ?? 0) + (name?.width ?? 0)).toBe(true);
  });

  test("a semicolon-separated file is read as a table", async () => {
    const { items } = await textItems(
      await rendered("text/csv", new TextEncoder().encode(csv(3, ";"))),
    );
    expect(items.some(({ text }) => text === "Částka")).toBe(true);
    expect(items.some(({ text }) => text.includes(";"))).toBe(false);
  });

  test("a table too wide for one page is split into bands of columns", async () => {
    const columns = 40;
    const header = Array.from(
      { length: columns },
      (_, index) => `Sloupec ${index + 1}`,
    );
    const row = Array.from(
      { length: columns },
      (_, index) => `hodnota ${index + 1}`,
    );
    const { items, pageCount, pageWidths } = await textItems(
      await rendered(
        "text/csv",
        new TextEncoder().encode([header.join(","), row.join(",")].join("\n")),
      ),
    );
    expect(pageCount).toBeGreaterThan(1);
    // Landscape A4.
    expect(pageWidths[0]).toBeCloseTo(841.89, 1);
    for (const index of [1, columns]) {
      expect(
        items.filter(({ text }) => text === `Sloupec ${index}`),
      ).toHaveLength(1);
    }
    for (const { width, x } of items) {
      expect(x + width).toBeLessThanOrEqual((pageWidths[0] ?? 0) - 36 + 1);
    }
  });

  test("a comma file whose values contain semicolons stays a comma table", async () => {
    const { items } = await textItems(
      await rendered(
        "text/csv",
        new TextEncoder().encode(
          "Jméno,Pobočky (Praha; Brno; Ostrava)\nAlice,Praha\nBob,Brno",
        ),
      ),
    );
    expect(items.some(({ text }) => text === "Alice")).toBe(true);
    expect(
      items.some(({ text }) => text === "Pobočky (Praha; Brno; Ostrava)"),
    ).toBe(true);
  });

  test("a comma table with a ragged record stays a table", async () => {
    const { items } = await textItems(
      await rendered(
        "text/csv",
        new TextEncoder().encode("Name,Amount\nAlice,10\nBob,20,note"),
      ),
    );
    for (const cell of ["Name", "Alice", "Bob", "note"]) {
      expect(items.some(({ text }) => text === cell)).toBe(true);
    }
  });

  test("a header taller than a third of a page is set once, not repeated", async () => {
    const tallHeader = Array.from(
      { length: 100 },
      (_, index) => `Hlavička ${index + 1}`,
    ).join("\n");
    const records = Array.from({ length: 120 }, (_, index) => `${index},x`);
    const { items, pageCount } = await textItems(
      await rendered(
        "text/csv",
        new TextEncoder().encode([`"${tallHeader}",b`, ...records].join("\n")),
      ),
    );
    expect(pageCount).toBeGreaterThan(2);
    expect(items.filter(({ text }) => text === "Hlavička 100")).toHaveLength(1);
    for (const index of [0, 60, 119]) {
      expect(items.filter(({ text }) => text === String(index))).toHaveLength(
        1,
      );
    }
  });

  test("a cell taller than many pages continues page after page", async () => {
    const tallCell = Array.from(
      { length: 3000 },
      (_, index) => `Řádek ${index + 1}`,
    ).join("\n");
    const { items, pageCount } = await textItems(
      await rendered(
        "text/csv",
        new TextEncoder().encode(`a,b\n"${tallCell}",x\nlast,y`),
      ),
    );
    expect(pageCount).toBeGreaterThan(10);
    for (const index of [1, 1500, 3000]) {
      expect(
        items.filter(({ text }) => text === `Řádek ${index}`),
      ).toHaveLength(1);
    }
    expect(items.filter(({ text }) => text === "last")).toHaveLength(1);
  });

  test("text that is not CSV is shown as text", async () => {
    const { items } = await textItems(
      await rendered(
        "text/csv",
        new TextEncoder().encode('a,"unterminated\nb,c'),
      ),
    );
    expect(readsBack(items, 'a,"unterminated')).toBe(true);
  });
});

const encode = (text: string) => new TextEncoder().encode(text);

/** Whether the last page of a preview is the shortened note. */
const endsWithNote = ({
  items,
  pageCount,
}: {
  items: readonly TextItem[];
  pageCount: number;
}) =>
  readsBack(
    items.filter(({ page }) => page === pageCount),
    PREVIEW_SHORTENED_NOTE,
  );

describe("what a text preview lays out is bounded", () => {
  const FILING =
    "spisu sp. zn. 23 C 114/2024 vedeného u Okresního soudu v Kolíně";
  /** One page per section: a form feed starts a page. */
  const sections = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `Strana ${index + 1} ${FILING}`,
    ).join("\f");

  test("text fills at most the page limit, then says it is shortened", async () => {
    const max = LIMITS.pdfRenderTextPagesMax;
    const atLimit = await textItems(
      await rendered("text/plain", encode(sections(max))),
    );
    expect(atLimit.pageCount).toBe(max);
    expect(endsWithNote(atLimit)).toBe(false);

    const past = await textItems(
      await rendered("text/plain", encode(sections(max + 1))),
    );
    // The limit's pages, then the note on a page of its own.
    expect(past.pageCount).toBe(max + 1);
    expect(endsWithNote(past)).toBe(true);
    expect(readsBack(past.items, `Strana ${max} ${FILING}`)).toBe(true);
    expect(readsBack(past.items, `Strana ${max + 1} ${FILING}`)).toBe(false);
  });

  test("a file at the byte budget is read whole", () => {
    const line =
      "Žalobce se domáhá zaplacení částky 125 400 Kč s příslušenstvím.\n";
    const lines = Math.floor(
      LIMITS.pdfRenderTextSourceBytesMax / encode(line).byteLength,
    );
    const body = line.repeat(lines);
    // Padded with ASCII up to the budget exactly.
    const text = `${body}${"x".repeat(LIMITS.pdfRenderTextSourceBytesMax - encode(body).byteLength)}`;
    expect(encode(text).byteLength).toBe(LIMITS.pdfRenderTextSourceBytesMax);

    expect(previewText(encode(text), "text/plain")).toEqual({
      text,
      shortened: false,
    });
  });

  test("a longer file is read up to the budget, back to its last whole line", () => {
    const line =
      "Žalobce se domáhá zaplacení částky 125 400 Kč s příslušenstvím.\r\n";
    const lineBytes = encode(line).byteLength;
    const bytes = encode(
      line.repeat(
        Math.ceil(LIMITS.pdfRenderTextSourceBytesMax / lineBytes) + 10,
      ),
    );
    // The budget falls inside a line's text, so cutting back is exercised.
    const into = LIMITS.pdfRenderTextSourceBytesMax % lineBytes;
    expect(into).toBeGreaterThan(0);
    expect(into).toBeLessThan(lineBytes - 2);

    const { shortened, text } = previewText(bytes, "text/plain");
    expect(shortened).toBe(true);
    const kept = Math.floor(LIMITS.pdfRenderTextSourceBytesMax / lineBytes);
    // Every whole line inside the budget, and not the CR of the last one.
    expect(text).toBe(line.repeat(kept).slice(0, -2));
  });

  test("a longer file without line breaks drops only a character the cut split", () => {
    // One ASCII byte, then two-byte letters: the budget, an even number of
    // bytes, ends halfway through a letter.
    const bytes = encode(`a${"ž".repeat(LIMITS.pdfRenderTextSourceBytesMax)}`);
    expect(LIMITS.pdfRenderTextSourceBytesMax % 2).toBe(0);

    const { shortened, text } = previewText(bytes, "text/plain");
    expect(shortened).toBe(true);
    expect(text).toBe(
      `a${"ž".repeat((LIMITS.pdfRenderTextSourceBytesMax - 2) / 2)}`,
    );
  });

  test("a replacement character the file holds at the budget is kept", () => {
    // ASCII up to three bytes before the budget, then U+FFFD (three bytes)
    // ending exactly at it: the cut splits nothing.
    const head = "x".repeat(LIMITS.pdfRenderTextSourceBytesMax - 3);
    const bytes = encode(`${head}�${"y".repeat(16)}`);
    expect(encode(`${head}�`).byteLength).toBe(
      LIMITS.pdfRenderTextSourceBytesMax,
    );

    expect(previewText(bytes, "text/plain")).toEqual({
      text: `${head}�`,
      shortened: true,
    });
  });

  test("a shortened file ends with the note even within the page limit", async () => {
    const fonts = await loadStampFonts();
    const text = `Strana 1 ${FILING}`;
    for (const toPdf of [plainTextToPdf, csvToPdf]) {
      const shortened = await textItems(
        await toPdf({ text, shortened: true }, fonts),
      );
      expect(shortened.pageCount).toBe(2);
      expect(endsWithNote(shortened)).toBe(true);
      const whole = await textItems(
        await toPdf({ text, shortened: false }, fonts),
      );
      expect(whole.pageCount).toBe(1);
      expect(endsWithNote(whole)).toBe(false);
    }
  });

  test("a table past the page limit stops there and says it is shortened", async () => {
    const records = Array.from(
      // About 46 records fit a page.
      { length: 60 * LIMITS.pdfRenderTextPagesMax },
      (_, index) =>
        `${index + 1},2025-03-${String((index % 28) + 1).padStart(2, "0")},Mgr. Petra Holubová,1.50`,
    );
    const { items, pageCount } = await textItems(
      await rendered(
        "text/csv",
        encode(["Číslo,Datum,Advokát,Hodiny", ...records].join("\n")),
      ),
    );
    expect(pageCount).toBe(LIMITS.pdfRenderTextPagesMax + 1);
    expect(endsWithNote({ items, pageCount })).toBe(true);
    // The header is still repeated on the last page of the table.
    expect(
      items.some(
        ({ page, text }) =>
          page === LIMITS.pdfRenderTextPagesMax && text === "Advokát",
      ),
    ).toBe(true);
    expect(items.some(({ text }) => text === String(records.length))).toBe(
      false,
    );
  });

  test("a table cut inside a quoted multi-line cell stays a table", async () => {
    const note = Array.from(
      { length: 40 },
      (_, index) => `bod ${index + 1} protokolu o jednání`,
    ).join("\n");
    const record = (index: number) => `${index + 1},"${note}"`;
    const recordBytes = encode(`${record(0)}\n`).byteLength;
    const bytes = encode(
      [
        "Číslo,Poznámka",
        ...Array.from(
          {
            length:
              Math.ceil(LIMITS.pdfRenderTextSourceBytesMax / recordBytes) + 5,
          },
          (_, index) => record(index),
        ),
      ].join("\n"),
    );
    // The cut lands inside a quoted cell: its quotes are left unbalanced.
    const cut = previewText(bytes, "text/csv");
    expect(cut.shortened).toBe(true);
    expect(cut.text.split('"').length % 2).toBe(0);

    const { items } = await textItems(await rendered("text/csv", bytes));
    expect(items.some(({ text }) => text === "Poznámka")).toBe(true);
    // Read as text, the quotes would show.
    expect(items.some(({ text }) => text.includes('"'))).toBe(false);
  });
});

/** Every page's size in pixels, at the 96 px per inch a page is sized by. */
const pagePixels = async (pdf: Uint8Array) => {
  const document = (await openPdfiumDocument(pdf)).unwrap();
  const sizes = Array.from({ length: document.pageCount }, (_, index) => {
    const { pointHeight, pointWidth } = document.pageSize(index).unwrap();
    return {
      width: Math.round(pointWidth / 0.75),
      height: Math.round(pointHeight / 0.75),
    };
  });
  document.close();
  return sizes;
};

describe("what an image preview decodes is bounded", () => {
  const MAX = LIMITS.pdfRenderImageDecodedBytesMax;

  test.each([
    ["an 8-bit", 8, 4],
    ["a 16-bit", 16, 8],
  ] as const)(
    "%s PNG decoding past the budget is too large; one at it is decoded",
    async (_name, bitDepth, bytesPerPixel) => {
      const width = 4096;
      const height = MAX / bytesPerPixel / width;
      expect(Number.isInteger(height)).toBe(true);

      // A header with no pixel data: the decoder, when it is reached,
      // refuses it.
      const atBudget = await renderPdf(
        "image/png",
        declaredPng({ bitDepth, height, width }),
      );
      expect(Result.isError(atBudget)).toBe(true);
      const past = await renderPdf(
        "image/png",
        declaredPng({ bitDepth, height, width: width + 1 }),
      );
      expect(Result.isOk(past) && past.value).toEqual({ type: "too-large" });
    },
  );

  test("an image past the page pixel budget is scaled down to it", async () => {
    const width = 4000;
    const height = 2100;
    expect(width * height).toBeGreaterThan(LIMITS.pdfRenderImagePixelsMax);

    const pdf = await rendered("image/webp", await splitWebp(width, height));
    const [page] = await pagePixels(pdf);
    expect((page?.width ?? 0) * (page?.height ?? 0)).toBeLessThanOrEqual(
      LIMITS.pdfRenderImagePixelsMax,
    );
    expect((page?.width ?? 0) / (page?.height ?? 1)).toBeCloseTo(
      width / height,
      2,
    );
    const [shown] = await renderPages(pdf);
    expect(isRed(shown?.colorAt(0.25, 0.5) ?? [0, 0, 0])).toBe(true);
    expect(isBlue(shown?.colorAt(0.75, 0.5) ?? [0, 0, 0])).toBe(true);
  });

  test("an image at the page pixel budget keeps its size", async () => {
    const width = 4000;
    const height = LIMITS.pdfRenderImagePixelsMax / width;
    const [page] = await pagePixels(
      await rendered("image/webp", await splitWebp(width, height)),
    );
    expect(page).toEqual({ width, height });
  });

  test("a TIFF page decoding past the budget is too large; one at it is read", () => {
    // Three 8-bit samples a pixel, plus the four of the RGBA they become.
    const bytesPerPixel = 3 + 4;
    const height = 4096;
    const width = Math.floor(
      LIMITS.pdfRenderTiffPageDecodedBytesMax / bytesPerPixel / height,
    );
    const declaring = (pageWidth: number) => {
      const tiff = tiffFile([splitTiffPage(8, 8)]);
      // ImageWidth (tag 256, LONG, one value) declares the size under test.
      const entry = indexOfBytes(
        tiff,
        Uint8Array.from([0x00, 0x01, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00]),
      );
      const heightEntry = indexOfBytes(
        tiff,
        Uint8Array.from([0x01, 0x01, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00]),
      );
      expect(entry).toBeGreaterThan(0);
      expect(heightEntry).toBeGreaterThan(0);
      const view = new DataView(tiff.buffer);
      view.setUint32(entry + 8, pageWidth, true);
      view.setUint32(heightEntry + 8, height, true);
      return tiff;
    };
    const options = {
      decodedBytesMax: LIMITS.pdfRenderTiffPageDecodedBytesMax,
      pagesMax: LIMITS.pdfRenderImagePagesMax,
    };
    expect(width * height * bytesPerPixel).toBeLessThanOrEqual(
      LIMITS.pdfRenderTiffPageDecodedBytesMax,
    );
    expect((width + 1) * height * bytesPerPixel).toBeGreaterThan(
      LIMITS.pdfRenderTiffPageDecodedBytesMax,
    );
    expect(Result.isOk(readTiffPages(declaring(width), options))).toBe(true);
    const past = readTiffPages(declaring(width + 1), options);
    expect(Result.isError(past) && past.error.reason).toBe("too-large");
  });

  test("a TIFF past the page limit shows the limit's pages, then the note", async () => {
    const max = LIMITS.pdfRenderImagePagesMax;
    const pages = (count: number) =>
      tiffFile(Array.from({ length: count }, () => splitTiffPage(16, 8)));

    const atLimit = await rendered("image/tiff", pages(max));
    expect(await pagePixels(atLimit)).toHaveLength(max);
    expect(endsWithNote(await textItems(atLimit))).toBe(false);

    const past = await rendered("image/tiff", pages(max + 1));
    const sizes = await pagePixels(past);
    expect(sizes).toHaveLength(max + 1);
    expect(sizes[max - 1]).toEqual({ width: 16, height: 8 });
    expect(endsWithNote(await textItems(past))).toBe(true);
  });
});
