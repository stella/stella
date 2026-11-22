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
 * {@link PAGES_PER_FONT_SUBSET} pages, so the laid-out glyphs held at once
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

/** Pages that share one subset of each embedded font. */
const PAGES_PER_FONT_SUBSET = 50;

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
const pageWriter = (pdf: PDF) => {
  let pending: PreviewPage[] = [];
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
    pending = [];
  };
  return {
    add: (page: PreviewPage) => {
      pending.push(page);
      if (pending.length >= PAGES_PER_FONT_SUBSET) {
        flush();
      }
    },
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

/** Plain text as an A4 PDF. */
export const plainTextToPdf = async (
  text: string,
  fonts: StampFonts,
): Promise<Uint8Array> => {
  const writer = pageWriter(PdfDocument.create());
  const layout = textLayout(fonts);
  const base = baseFace(fonts);
  const size = TEXT_FONT_SIZE;
  const top = A4.height - TEXT_MARGIN;
  const width = A4.width - 2 * TEXT_MARGIN;
  let rows: PositionedStampRow[] = [];
  let y = top;
  const endPage = () => {
    writer.add({ rows, size: A4, underlay: [] });
    rows = [];
    y = top;
  };
  for (const [sectionIndex, section] of text.split("\f").entries()) {
    if (sectionIndex > 0) {
      endPage();
    }
    for (const line of section.split(LINE_BREAK)) {
      for (const { row, rtl } of layoutLines(layout, line, width, size)) {
        const { ascent, pitch } = rowMetrics(row, base);
        if (rows.length > 0 && y - pitch * size < TEXT_MARGIN) {
          endPage();
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
  if (rows.length > 0) {
    endPage();
  }
  return await writer.finish();
};

/**
 * The records of a CSV file, read with the delimiter (comma, semicolon or
 * tab) under which the most records are as wide as the header, the wider
 * table on a tie (and the earlier delimiter after that), or `null` when no
 * delimiter reads it as CSV. Consistency comes first: a comma file whose
 * values contain semicolons must not read as a ragged semicolon table.
 */
const readCsvRecords = (text: string): string[][] | null => {
  const source = text.replace(/^\uFEFF/u, "");
  let best: { rows: string[][]; consistent: number; width: number } | null =
    null;
  for (const delimiter of CSV_DELIMITERS) {
    const parsed = parseCSVWithMetadata(source, { delimiter });
    if (parsed.status !== CSV_PARSE_STATUS.SUCCESS) {
      continue;
    }
    const width = parsed.rows[0]?.length ?? 0;
    const consistent = parsed.rows.filter((row) => row.length === width).length;
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

/** The leading rows of a block that fit `room` points (at least one), and the rest. */
const splitLines = (
  lines: readonly TextRow[],
  room: number,
  base: StampFace,
) => {
  let used = 0;
  let count = 0;
  for (const { row } of lines) {
    const pitch = rowMetrics(row, base).pitch * TABLE_FONT_SIZE;
    if (count > 0 && used + pitch > room) {
      break;
    }
    used += pitch;
    count += 1;
  }
  return { fit: lines.slice(0, count), rest: lines.slice(count) };
};

/** CSV as a PDF table, or as plain text when it does not read as CSV. */
export const csvToPdf = async (
  text: string,
  fonts: StampFonts,
): Promise<Uint8Array> => {
  const records = readCsvRecords(text);
  if (records === null) {
    return await plainTextToPdf(text, fonts);
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
  const writer = pageWriter(PdfDocument.create());

  for (const band of columnBands(natural, size.width - 2 * TABLE_MARGIN)) {
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
    const startPage = () => {
      const page = tablePage(size, columns, base);
      page.place(headerCells, headerHeight, true);
      return page;
    };
    let page = startPage();
    for (const record of body) {
      let cells: PlacedCell[] = cellsOf(record, layout);
      for (;;) {
        const height = cellsHeight(cells, base);
        if (height <= page.room()) {
          page.place(cells, height, false);
          break;
        }
        if (page.hasBody()) {
          writer.add(page.take());
          page = startPage();
          continue;
        }
        // Taller than a whole page: place what fits and carry the rest.
        const room = page.room() - 2 * CELL_PADDING_Y;
        const split = cells.map((cell) => ({
          cell,
          ...splitLines(cell.lines, room, base),
        }));
        const placed = split.map(({ cell, fit }) => ({ ...cell, lines: fit }));
        page.place(placed, cellsHeight(placed, base), false);
        writer.add(page.take());
        page = startPage();
        cells = split.map(({ cell, rest }) => ({ ...cell, lines: rest }));
        if (cells.every(({ lines }) => lines.length === 0)) {
          break;
        }
      }
    }
    writer.add(page.take());
  }
  return await writer.finish();
};
