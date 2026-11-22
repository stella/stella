import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { readImageHeader } from "@/api/lib/files/image-header";
import { renderPdf } from "@/api/lib/files/pdf-render";
import { openPdfiumDocument } from "@/api/lib/files/pdfium";
import {
  splitBmp,
  splitGif,
  splitJpeg,
  splitPng,
  splitTiffPage,
  splitWebp,
  tiffFile,
} from "@/api/tests/helpers/image-fixtures";

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
  return result.value;
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

  test("a TIFF whose pixels are cut short is refused, not rendered", async () => {
    const tiff = tiffFile([splitTiffPage(64, 32)]);
    // Keep the header and first strip bytes, drop the directory.
    const result = await renderPdf("image/tiff", tiff.subarray(0, 64));
    expect(Result.isError(result)).toBe(true);
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
