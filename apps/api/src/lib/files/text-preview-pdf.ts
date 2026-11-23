/**
 * PDF previews of plain text and CSV, laid out in-process.
 *
 * Plain text: A4 portrait, one row per wrapped line; a form feed starts a
 * new page and a tab advances to the next multiple of eight columns.
 *
 * CSV: a table whose header row (the file's first record) repeats at the
 * top of every page. A table wider than portrait A4 is set on landscape A4,
 * and one too wide for that at a readable column width is split into bands
 * of consecutive columns, each band a table of its own with every record.
 *
 * Fonts are embedded as subsets shared by each run of
 * `TextPages.pagesPerFontRun` pages, so the laid-out glyphs held at once
 * stay bounded however long the file is.
 */

import type { PDF } from "@libpdf/core";
import { PDF as PdfDocument, PdfDict, PdfName, PdfStream } from "@libpdf/core";
import { panic } from "better-result";
import { deflateSync } from "node:zlib";

import {
  CSV_DELIMITERS,
  CSV_PARSE_STATUS,
  parseCSVWithMetadata,
} from "@/api/lib/csv";
import {
  PDF_NEUTRALS,
  pdfFillColor,
  pdfStrokeColor,
} from "@/api/lib/files/pdf-color";
import { saveCreatedPdf } from "@/api/lib/files/pdf-signatures";
import {
  boldStampFonts,
  type StampFace,
  type StampFonts,
} from "@/api/lib/files/pdf-signing/stamp-font";
import {
  drawStampRowGroups,
  pdfNumber,
} from "@/api/lib/files/pdf-signing/stamp-glyphs";
import {
  type PositionedStampRow,
  STAMP_UNITS_PER_EM,
} from "@/api/lib/files/pdf-signing/stamp-layout";
import {
  layoutParagraph,
  paragraphPieces,
  rowMetrics,
  type TextLayout,
  textLayout,
  type TextRow,
} from "@/api/lib/files/text-preview-layout";

/** A4, in points. */
const A4 = { width: 595.28, height: 841.89 } as const;
const A4_LANDSCAPE = { width: A4.height, height: A4.width } as const;
type PageSize = { width: number; height: number };

/**
 * How many pages a text preview lays out, and how many it holds before
 * writing them out with one subset of each font: the pages held, and the
 * layout garbage collected after them, are what its memory peaks with.
 */
export type TextPages = { pagesMax: number; pagesPerFontRun: number };

const TEXT_FONT_SIZE = 10;
/** 2 cm. */
const TEXT_MARGIN = 56.69;
const TAB_COLUMNS = 8;

const TABLE_FONT_SIZE = 9;
/** Half an inch. */
const TABLE_MARGIN = 36;
const CELL_PADDING_X = 4;
const CELL_PADDING_Y = 2.5;
const RULE_WIDTH = 0.5;
/** A column is never set narrower than this many ems of text. */
const COLUMN_MIN_EMS = 6;
/** The share of a page's height a repeated header row may take. */
const HEADER_SHARE_MAX = 1 / 3;
/** Records measured to choose column widths. */
const COLUMN_SAMPLE_RECORDS = 500;
/** Absorbs rounding, so a cell measured on one line stays on one line. */
const MEASURE_SLACK = 0.01;

type PreviewPage = {
  size: PageSize;
  rows: PositionedStampRow[];
  /** Operators drawn beneath the text: a table's fills and rules. */
  underlay: string[];
};

const encoder = new TextEncoder();

/**
 * Collects pages and writes them, in the order they are added, in runs that
 * share their font subsets.
 */
const pageWriter = (pdf: PDF, pagesPerFontRun: number) => {
  let pending: PreviewPage[] = [];
  let written = 0;
  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    const { fonts, operators } = drawStampRowGroups({
      groups: pending.map(({ rows }) => rows),
      pdf,
    });
    for (const [index, { size, underlay }] of pending.entries()) {
      const page = pdf.addPage({ width: size.width, height: size.height });
      const content = [
        ...(underlay.length === 0 ? [] : ["q", ...underlay, "Q"]),
        "BT",
        ...(operators[index] ?? panic("Every pending page has its operators")),
        "ET",
      ].join("\n");
      page.dict.set(
        "Contents",
        pdf.context.registry.register(
          new PdfStream(
            PdfDict.of({ Filter: PdfName.of("FlateDecode") }),
            deflateSync(encoder.encode(content)),
          ),
        ),
      );
      page.dict.set("Resources", PdfDict.of({ Font: fonts }));
    }
    written += pending.length;
    pending = [];
    // Previews render only in the PDF worker, a process of their own: a full
    // collection after each run returns the run's layout before the next
    // one is set, instead of whenever the heap next grows.
    Bun.gc(true);
  };
  return {
    add: (page: PreviewPage) => {
      pending.push(page);
      if (pending.length >= pagesPerFontRun) {
        flush();
      }
    },
    /** Pages added so far. */
    count: () => written + pending.length,
    flush,
    finish: async (): Promise<Uint8Array> => {
      flush();
      if (pdf.getPageCount() === 0) {
        pdf.addPage({ width: A4.width, height: A4.height });
      }
      return await saveCreatedPdf(pdf);
    },
  };
};

/** Tabs advanced to the next multiple of {@link TAB_COLUMNS} columns. */
const expandTabs = (line: string) => {
  if (!line.includes("\t")) {
    return line;
  }
  let out = "";
  let column = 0;
  for (const character of line) {
    if (character === "\t") {
      const spaces = TAB_COLUMNS - (column % TAB_COLUMNS);
      out += " ".repeat(spaces);
      column += spaces;
    } else {
      out += character;
      column += 1;
    }
  }
  return out;
};

/** Line breaks: CRLF, CR, LF, VT, NEL, and the line and paragraph separators. */
const LINE_BREAK = /\r\n|[\n\v\r\u0085\u2028\u2029]/u;

const toEms = (points: number, fontSize: number) =>
  (points / fontSize) * STAMP_UNITS_PER_EM;
const toPoints = (units: number, fontSize: number) =>
  (units * fontSize) / STAMP_UNITS_PER_EM;

/** Every line of `text` set into rows no wider than `width` points. */
const layoutLines = (
  layout: TextLayout,
  text: string,
  width: number,
  fontSize: number,
): TextRow[] =>
  text
    .split(LINE_BREAK)
    .flatMap((line) =>
      paragraphPieces(expandTabs(line)).flatMap((piece) =>
        layoutParagraph(layout, piece, toEms(width, fontSize)),
      ),
    );

const baseFace = (fonts: StampFonts): StampFace =>
  fonts.faces[0] ?? panic("The preview fonts have no face");

/**
 * What a text preview lays out: the start of the file, and whether there is
 * more of it (see `PdfRenderBudget.textSourceBytesMax`).
 */
export type TextPreviewSource = { text: string; shortened: boolean };

/**
 * Said on a page of its own at the end of a preview that does not show the
 * whole file. A preview PDF is built once per file and shown to every
 * reader, so it is in English, as the text of other derived previews is.
 */
export const PREVIEW_SHORTENED_NOTE =
  "This preview shows only the beginning of the file. The original file is unchanged: download it to see all of it.";

/** The shortened note set as an A4 page. */
const shortenedNotePage = (fonts: StampFonts): PreviewPage => {
  const base = baseFace(fonts);
  const size = TEXT_FONT_SIZE;
  let y = A4.height - TEXT_MARGIN;
  const rows: PositionedStampRow[] = [];
  for (const { row } of layoutLines(
    textLayout(boldStampFonts(fonts)),
    PREVIEW_SHORTENED_NOTE,
    A4.width - 2 * TEXT_MARGIN,
    size,
  )) {
    const { ascent, pitch } = rowMetrics(row, base);
    rows.push({
      color: PDF_NEUTRALS.black,
      fontSize: size,
      row,
      x: TEXT_MARGIN,
      y: y - ascent * size,
    });
    y -= pitch * size;
  }
  return { rows, size: A4, underlay: [] };
};

/** Adds the shortened note to `pdf` as its next page. */
export const addShortenedNotePage = (pdf: PDF, fonts: StampFonts): void => {
  const writer = pageWriter(pdf, 1);
  writer.add(shortenedNotePage(fonts));
  writer.flush();
};

/**
 * Plain text as an A4 PDF of at most `pages.pagesMax` pages, then the
 * shortened note when the file has more than that or than the text given.
 */
export const plainTextToPdf = async (
  { shortened, text }: TextPreviewSource,
  fonts: StampFonts,
  { pagesMax, pagesPerFontRun }: TextPages,
): Promise<Uint8Array> => {
  const writer = pageWriter(PdfDocument.create(), pagesPerFontRun);
  const layout = textLayout(fonts);
  const base = baseFace(fonts);
  const size = TEXT_FONT_SIZE;
  const top = A4.height - TEXT_MARGIN;
  const width = A4.width - 2 * TEXT_MARGIN;
  let rows: PositionedStampRow[] = [];
  let y = top;
  /** Writes the page; `false` once the page limit is reached. */
  const endPage = (): boolean => {
    writer.add({ rows, size: A4, underlay: [] });
    rows = [];
    y = top;
    return writer.count() < pagesMax;
  };
  /** Sets the text page by page; `true` when the page limit cut it short. */
  const place = (): boolean => {
    for (const [sectionIndex, section] of text.split("\f").entries()) {
      if (sectionIndex > 0 && !endPage()) {
        return true;
      }
      for (const line of section.split(LINE_BREAK)) {
        // Piece by piece, so a line of megabytes is placed as it is set
        // instead of being held whole.
        for (const piece of paragraphPieces(expandTabs(line))) {
          for (const { row, rtl } of layoutParagraph(
            layout,
            piece,
            toEms(width, size),
          )) {
            const { ascent, pitch } = rowMetrics(row, base);
            if (
              rows.length > 0 &&
              y - pitch * size < TEXT_MARGIN &&
              !endPage()
            ) {
              return true;
            }
            const rowWidth = toPoints(row.width, size);
            rows.push({
              color: PDF_NEUTRALS.black,
              fontSize: size,
              row,
              x: rtl ? A4.width - TEXT_MARGIN - rowWidth : TEXT_MARGIN,
              y: y - ascent * size,
            });
            y -= pitch * size;
          }
        }
      }
    }
    return false;
  };
  const cut = place();
  if (rows.length > 0) {
    endPage();
  }
  if (shortened || cut) {
    writer.add(shortenedNotePage(fonts));
  }
  return await writer.finish();
};

/**
 * The records of a CSV file, read with the delimiter (comma, semicolon or
 * tab) under which the most records are as wide as a header of at least two
 * columns, the wider table on a tie (and the earlier delimiter after that),
 * or `null` when no delimiter reads it as CSV. Consistency comes first, so a
 * comma file whose values contain semicolons does not read as a ragged
 * semicolon table; and a reading of one field per line counts no consistent
 * records, so it never outranks a table with a ragged record.
 */
const readCsvRecords = ({
  shortened,
  text,
}: TextPreviewSource): string[][] | null => {
  const source = text.replace(/^\uFEFF/u, "");
  let best: { rows: string[][]; consistent: number; width: number } | null =
    null;
  for (const delimiter of CSV_DELIMITERS) {
    // A shortened file was cut at a line break, which may fall inside a
    // quoted field: that record is the one the cut split.
    const parsed = parseCSVWithMetadata(source, {
      delimiter,
      prefix: shortened,
    });
    if (parsed.status !== CSV_PARSE_STATUS.SUCCESS) {
      continue;
    }
    const width = parsed.rows[0]?.length ?? 0;
    const consistent =
      width > 1 ? parsed.rows.filter((row) => row.length === width).length : 0;
    if (
      best === null ||
      consistent > best.consistent ||
      (consistent === best.consistent && width > best.width)
    ) {
      best = { consistent, rows: parsed.rows, width };
    }
  }
  return best === null || best.rows.length === 0 ? null : best.rows;
};

/**
 * Split columns into bands that fit `available` points with each column at
 * least {@link COLUMN_MIN_EMS} wide (or its natural width when narrower),
 * then share each band's width: a column takes its natural width when that
 * is at most an equal share of what is left, and the widest columns split
 * the rest evenly.
 */
const columnBands = (
  natural: readonly number[],
  available: number,
): { column: number; width: number }[][] => {
  const minimum = COLUMN_MIN_EMS * TABLE_FONT_SIZE + 2 * CELL_PADDING_X;
  const bands: number[][] = [];
  let band: number[] = [];
  let used = 0;
  for (const [column, width] of natural.entries()) {
    const need = Math.min(width, minimum);
    if (band.length > 0 && used + need > available) {
      bands.push(band);
      band = [];
      used = 0;
    }
    band.push(column);
    used += need;
  }
  if (band.length > 0) {
    bands.push(band);
  }
  return bands.map((columns) => {
    const widths = new Map<number, number>();
    let open = [...columns];
    let left = available;
    while (open.length > 0) {
      const share = left / open.length;
      const fitting = open.filter((column) => (natural[column] ?? 0) <= share);
      if (fitting.length === 0) {
        for (const column of open) {
          widths.set(column, share);
        }
        break;
      }
      for (const column of fitting) {
        const width = natural[column] ?? 0;
        widths.set(column, width);
        left -= width;
      }
      open = open.filter((column) => !fitting.includes(column));
    }
    return columns.map((column) => ({
      column,
      width: widths.get(column) ?? panic("A column was left without a width"),
    }));
  });
};

type Column = { column: number; width: number; x: number };
type PlacedCell = { lines: readonly TextRow[]; x: number; width: number };

/**
 * One table page: rows are placed top down, the header first, and the grid
 * and the header's shading are drawn when the page is taken.
 */
const tablePage = (
  size: PageSize,
  columns: readonly Column[],
  base: StampFace,
) => {
  const rows: PositionedStampRow[] = [];
  const rules: number[] = [];
  const top = size.height - TABLE_MARGIN;
  let y = top;
  let headerBottom: number | null = null;
  let bodyRows = 0;
  const left = columns[0]?.x ?? TABLE_MARGIN;
  const last = columns.at(-1);
  const right = last === undefined ? left : last.x + last.width;
  return {
    room: () => y - TABLE_MARGIN,
    hasBody: () => bodyRows > 0,
    place: (cells: readonly PlacedCell[], height: number, header: boolean) => {
      for (const { lines, width, x } of cells) {
        let lineTop = y - CELL_PADDING_Y;
        for (const { row, rtl } of lines) {
          const { ascent, pitch } = rowMetrics(row, base);
          const rowWidth = toPoints(row.width, TABLE_FONT_SIZE);
          rows.push({
            color: PDF_NEUTRALS.black,
            fontSize: TABLE_FONT_SIZE,
            row,
            x: rtl ? x + width - CELL_PADDING_X - rowWidth : x + CELL_PADDING_X,
            y: lineTop - ascent * TABLE_FONT_SIZE,
          });
          lineTop -= pitch * TABLE_FONT_SIZE;
        }
      }
      y -= height;
      rules.push(y);
      if (header) {
        headerBottom = y;
      } else {
        bodyRows += 1;
      }
    },
    take: (): PreviewPage => {
      const line = (x1: number, y1: number, x2: number, y2: number) =>
        `${pdfNumber(x1)} ${pdfNumber(y1)} m ${pdfNumber(x2)} ${pdfNumber(y2)} l`;
      const underlay: string[] = [];
      if (headerBottom !== null) {
        underlay.push(
          pdfFillColor(PDF_NEUTRALS.tableHeaderFill),
          `${pdfNumber(left)} ${pdfNumber(headerBottom)} ${pdfNumber(right - left)} ${pdfNumber(top - headerBottom)} re f`,
        );
      }
      underlay.push(
        pdfStrokeColor(PDF_NEUTRALS.tableRule),
        `${pdfNumber(RULE_WIDTH)} w`,
        line(left, top, right, top),
        ...rules.map((rule) => line(left, rule, right, rule)),
        ...[...columns.map(({ x }) => x), right].map((x) => line(x, top, x, y)),
        "S",
      );
      return { rows, size, underlay };
    },
  };
};

/** A block of rows' height in points. */
const blockHeight = (lines: readonly TextRow[], base: StampFace) =>
  lines.reduce(
    (total, { row }) => total + rowMetrics(row, base).pitch * TABLE_FONT_SIZE,
    0,
  );

/** A row of cells' height in points, padding included. */
const cellsHeight = (cells: readonly PlacedCell[], base: StampFace) =>
  Math.max(0, ...cells.map(({ lines }) => blockHeight(lines, base))) +
  2 * CELL_PADDING_Y;

/** Where a cell's rows have been placed up to, with their pitches summed. */
type CellCursor = PlacedCell & {
  /** `offsets[i]` is the height of rows `0..i-1`, in points. */
  offsets: number[];
  next: number;
};

const cellCursor = (cell: PlacedCell, base: StampFace): CellCursor => {
  const offsets = [0];
  let total = 0;
  for (const { row } of cell.lines) {
    total += rowMetrics(row, base).pitch * TABLE_FONT_SIZE;
    offsets.push(total);
  }
  return { ...cell, next: 0, offsets };
};

/** The height of a cell's rows not yet placed. */
const remainingHeight = ({ next, offsets }: CellCursor) =>
  (offsets.at(-1) ?? 0) - (offsets[next] ?? 0);

/**
 * The cell's next rows that fit a block `height` points tall, padding
 * included (at least one, so a row taller than a page still moves on), and
 * the cursor moved past them.
 */
const takeLines = (cursor: CellCursor, height: number): PlacedCell => {
  const start = cursor.next;
  const top = cursor.offsets[start] ?? 0;
  let end = start;
  while (
    end < cursor.lines.length &&
    (end === start ||
      (cursor.offsets[end + 1] ?? 0) - top <= height - 2 * CELL_PADDING_Y)
  ) {
    end += 1;
  }
  cursor.next = end;
  return {
    lines: cursor.lines.slice(start, end),
    width: cursor.width,
    x: cursor.x,
  };
};

/**
 * CSV as a PDF table of at most `pages.pagesMax` pages, then
 * the shortened note when the file has more; or as plain text when it does
 * not read as CSV.
 */
export const csvToPdf = async (
  source: TextPreviewSource,
  fonts: StampFonts,
  pages: TextPages,
): Promise<Uint8Array> => {
  const { shortened } = source;
  const records = readCsvRecords(source);
  if (records === null) {
    return await plainTextToPdf(source, fonts, pages);
  }
  const base = baseFace(fonts);
  const layout = textLayout(fonts);
  const boldLayout = textLayout(boldStampFonts(fonts));
  // Looped, not spread: a tall file has more records than a call takes
  // arguments.
  let columnCount = 0;
  for (const record of records) {
    columnCount = Math.max(columnCount, record.length);
  }
  const [header, ...body] = records;
  if (header === undefined) {
    return panic("A CSV read as records has at least one");
  }
  const cellText = (record: readonly string[], column: number) =>
    record[column] ?? "";
  const naturalWidth = (cellLayout: TextLayout, value: string) => {
    let widest = 0;
    for (const { row } of layoutLines(
      cellLayout,
      value,
      Number.POSITIVE_INFINITY,
      TABLE_FONT_SIZE,
    )) {
      widest = Math.max(widest, toPoints(row.width, TABLE_FONT_SIZE));
    }
    return widest;
  };
  const natural = Array.from(
    { length: columnCount },
    (_, column) =>
      Math.max(
        TABLE_FONT_SIZE,
        naturalWidth(boldLayout, cellText(header, column)),
        ...body
          .slice(0, COLUMN_SAMPLE_RECORDS)
          .map((record) => naturalWidth(layout, cellText(record, column))),
      ) +
      2 * CELL_PADDING_X +
      MEASURE_SLACK,
  );
  const total = natural.reduce((sum, width) => sum + width, 0);
  const size = total <= A4.width - 2 * TABLE_MARGIN ? A4 : A4_LANDSCAPE;
  const writer = pageWriter(PdfDocument.create(), pages.pagesPerFontRun);
  const full = () => writer.count() >= pages.pagesMax;
  const bands = columnBands(natural, size.width - 2 * TABLE_MARGIN);

  /** One band's table; `true` when the page limit cut it short. */
  const placeBand = (band: (typeof bands)[number]): boolean => {
    let x = TABLE_MARGIN;
    const columns: Column[] = band.map(({ column, width }) => {
      const placed = { column, width, x };
      x += width;
      return placed;
    });
    const cellsOf = (record: readonly string[], cellLayout: TextLayout) =>
      columns.map(({ column, width, x: cellX }) => ({
        lines: layoutLines(
          cellLayout,
          cellText(record, column),
          width - 2 * CELL_PADDING_X,
          TABLE_FONT_SIZE,
        ),
        width,
        x: cellX,
      }));
    const headerCells = cellsOf(header, boldLayout);
    const headerHeight = cellsHeight(headerCells, base);
    // A header taller than this would leave a page too little room for
    // records, so it is set once, as the first record, and not repeated.
    const repeatHeader =
      headerHeight <= (size.height - 2 * TABLE_MARGIN) * HEADER_SHARE_MAX;
    const startPage = () => {
      const page = tablePage(size, columns, base);
      if (repeatHeader) {
        page.place(headerCells, headerHeight, true);
      }
      return page;
    };
    // Without a repeated header, the header is the band's first record.
    const recordCount = body.length + (repeatHeader ? 0 : 1);
    const cellsAt = (index: number) => {
      if (!repeatHeader && index === 0) {
        return headerCells;
      }
      return cellsOf(
        body[repeatHeader ? index : index - 1] ??
          panic("A record index is inside the body"),
        layout,
      );
    };
    let page = startPage();
    /** Writes the page and starts the next; `false` at the page limit. */
    const turnPage = () => {
      writer.add(page.take());
      if (full()) {
        return false;
      }
      page = startPage();
      return true;
    };
    for (let index = 0; index < recordCount; index += 1) {
      const cursors = cellsAt(index).map((cell) => cellCursor(cell, base));
      for (;;) {
        const rest =
          Math.max(0, ...cursors.map(remainingHeight)) + 2 * CELL_PADDING_Y;
        if (rest <= page.room()) {
          const placed = cursors.map((cursor) => takeLines(cursor, rest));
          page.place(placed, rest, false);
          break;
        }
        if (page.hasBody()) {
          if (!turnPage()) {
            return true;
          }
          continue;
        }
        // Taller than a whole page: place what fits and carry the rest.
        const room = page.room();
        const placed = cursors.map((cursor) => takeLines(cursor, room));
        page.place(placed, cellsHeight(placed, base), false);
        const placedWhole = cursors.every(
          (cursor) => remainingHeight(cursor) === 0,
        );
        if (!turnPage()) {
          return !placedWhole || index < recordCount - 1;
        }
        if (placedWhole) {
          break;
        }
      }
    }
    writer.add(page.take());
    return false;
  };

  /** Sets every band, page by page; `true` when the page limit cut it short. */
  const place = (): boolean => {
    for (const [bandIndex, band] of bands.entries()) {
      if (placeBand(band)) {
        return true;
      }
      if (full() && bandIndex < bands.length - 1) {
        return true;
      }
    }
    return false;
  };

  const cut = place();
  if (shortened || cut) {
    writer.add(shortenedNotePage(fonts));
  }
  return await writer.finish();
};
