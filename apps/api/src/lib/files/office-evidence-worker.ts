/**
 * Isolated, bounded XLSX/PPTX locator extraction worker.
 * stdin is the original OOXML file; stdout is one JSON result.
 */

import {
  materializePptxPresentation,
  materializeXlsxWorkbook,
} from "@silurus/ooxml/node";

import {
  OFFICE_EVIDENCE_FORMAT,
  OFFICE_EVIDENCE_UNAVAILABLE_CODE,
  type OfficeEvidenceFormat,
  type OfficeEvidencePayload,
  type OfficeEvidenceWorkerResult,
  type PptxOfficeEvidenceBlock,
  type XlsxOfficeEvidenceBlock,
} from "@/api/lib/files/office-evidence-types";
import { LIMITS } from "@/api/lib/limits";

const MEBIBYTE = 1024 * 1024;
const RESOURCE_LIMITS = {
  maxArchiveEntries: 2048,
  maxArchiveEntryBytes: 64 * MEBIBYTE,
  maxTotalInflatedBytes: 192 * MEBIBYTE,
} as const;

type MaterializedWorkbook = Awaited<ReturnType<typeof materializeXlsxWorkbook>>;
type MaterializedPresentation = Awaited<
  ReturnType<typeof materializePptxPresentation>
>;
type SpreadsheetCell =
  MaterializedWorkbook["worksheets"][number]["rows"][number]["cells"][number];
type SharedStrings = MaterializedWorkbook["workbookIndex"]["sharedStrings"];
type PresentationTextBody = NonNullable<
  Extract<
    MaterializedPresentation["slides"][number]["elements"][number],
    { type: "shape" }
  >["textBody"]
>;

const normalizeText = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();

const createBlockId = (
  format: OfficeEvidenceFormat,
  locatorKey: string,
  text: string,
): string =>
  `${format}-${new Bun.CryptoHasher("sha256")
    .update(`${format}\0${locatorKey}\0${text}`)
    .digest("hex")
    .slice(0, 16)}`;

const toSpreadsheetColumnName = (columnIndex: number): string => {
  let current = columnIndex;
  let name = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCodePoint(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
};

const cellValueText = (
  cell: SpreadsheetCell,
  sharedStrings: SharedStrings,
): string => {
  switch (cell.value.type) {
    case "bool":
      return cell.value.bool ? "TRUE" : "FALSE";
    case "empty":
      return "";
    case "error":
      return cell.value.error;
    case "number":
      return String(cell.value.number);
    case "shared":
      return sharedStrings.at(cell.value.si)?.text ?? "";
    case "text":
      return cell.value.text;
    default: {
      const exhaustive: never = cell.value;
      return exhaustive;
    }
  }
};

const buildCellText = (
  cell: SpreadsheetCell,
  sharedStrings: SharedStrings,
): string => {
  const reference = `${toSpreadsheetColumnName(cell.col)}${String(cell.row)}`;
  const value = normalizeText(cellValueText(cell, sharedStrings));
  if (cell.formula) {
    const formula = cell.formula.startsWith("=")
      ? cell.formula
      : `=${cell.formula}`;
    return value
      ? `${reference}: ${formula} → ${value}`
      : `${reference}: ${formula}`;
  }
  return value ? `${reference}: ${value}` : "";
};

const extractXlsxBlocks = async (
  bytes: Uint8Array,
): Promise<OfficeEvidencePayload> => {
  const materialized = await materializeXlsxWorkbook(bytes, {
    resourceLimits: RESOURCE_LIMITS,
  });
  const blocks: XlsxOfficeEvidenceBlock[] = [];
  const { sharedStrings } = materialized.workbookIndex;

  for (const [sheetIndex, worksheet] of materialized.worksheets.entries()) {
    for (const row of worksheet.rows) {
      const cells = row.cells
        .map((cell) => ({ cell, text: buildCellText(cell, sharedStrings) }))
        .filter(({ text }) => text.length > 0);
      let chunk: typeof cells = [];
      let chunkChars = 0;

      const flush = () => {
        if (blocks.length >= LIMITS.officeCitationBlocksMax) {
          return;
        }
        const first = chunk.at(0);
        const last = chunk.at(-1);
        if (!first || !last) {
          return;
        }
        const start = `${toSpreadsheetColumnName(first.cell.col)}${String(
          first.cell.row,
        )}`;
        const end = `${toSpreadsheetColumnName(last.cell.col)}${String(
          last.cell.row,
        )}`;
        const range = start === end ? start : `${start}:${end}`;
        const text = chunk
          .map((entry) => entry.text)
          .join(" | ")
          .slice(0, LIMITS.officeCitationBlockTextMaxChars);
        blocks.push({
          id: createBlockId("xlsx", `${String(sheetIndex)}:${range}`, text),
          locator: {
            type: "xlsx",
            range,
            sheetIndex,
            sheetName: worksheet.name.slice(0, 31),
          },
          text,
        });
        chunk = [];
        chunkChars = 0;
      };

      for (const entry of cells) {
        const separatorChars = chunk.length === 0 ? 0 : 3;
        if (
          chunk.length > 0 &&
          chunkChars + separatorChars + entry.text.length >
            LIMITS.officeCitationBlockTextMaxChars
        ) {
          flush();
        }
        chunk.push(entry);
        chunkChars += separatorChars + entry.text.length;
      }
      flush();

      if (blocks.length >= LIMITS.officeCitationBlocksMax) {
        return { blocks, format: "xlsx", version: 1 };
      }
    }
  }

  return { blocks, format: "xlsx", version: 1 };
};

const textBodyText = (textBody: PresentationTextBody): string =>
  textBody.paragraphs
    .map((paragraph) =>
      paragraph.runs
        .map((run) => {
          if (run.type === "text") {
            return run.text;
          }
          return run.type === "break" ? "\n" : "";
        })
        .join(""),
    )
    .join("\n");

const slideText = (
  slide: MaterializedPresentation["slides"][number],
): string => {
  const parts: string[] = [];
  for (const element of slide.elements) {
    if (element.type === "shape" && element.textBody) {
      parts.push(textBodyText(element.textBody));
      continue;
    }
    if (element.type === "table") {
      for (const row of element.rows) {
        parts.push(
          row.cells
            .map((cell) => (cell.textBody ? textBodyText(cell.textBody) : ""))
            .join(" | "),
        );
      }
      continue;
    }
    if (element.type === "chart") {
      const { chart } = element;
      parts.push(chart.title ?? "", chart.categories.join(" | "));
      for (const series of chart.series) {
        parts.push(`${series.name}: ${series.values.join(" | ")}`);
      }
    }
  }
  if (slide.notes) {
    parts.push(slide.notes);
  }
  return normalizeText(parts.join("\n"));
};

const extractPptxBlocks = async (
  bytes: Uint8Array,
): Promise<OfficeEvidencePayload> => {
  const presentation = await materializePptxPresentation(bytes, {
    resourceLimits: RESOURCE_LIMITS,
  });
  const blocks: PptxOfficeEvidenceBlock[] = [];
  for (const [slideIndex, slide] of presentation.slides.entries()) {
    const text = slideText(slide).slice(
      0,
      LIMITS.officeCitationBlockTextMaxChars,
    );
    if (!text) {
      continue;
    }
    blocks.push({
      id: createBlockId("pptx", String(slideIndex), text),
      locator: { type: "pptx", slideIndex },
      text,
    });
    if (blocks.length >= LIMITS.officeCitationBlocksMax) {
      break;
    }
  }
  return { blocks, format: "pptx", version: 1 };
};

const classifyFailure = (error: unknown) => {
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ooxml-resource-limit" ||
      error.code === "ooxml-decoded-image-limit")
  ) {
    return OFFICE_EVIDENCE_UNAVAILABLE_CODE.resourceLimit;
  }
  return OFFICE_EVIDENCE_UNAVAILABLE_CODE.parseFailed;
};

const main = async (): Promise<void> => {
  const format = process.argv.at(2);
  if (
    format !== OFFICE_EVIDENCE_FORMAT.xlsx &&
    format !== OFFICE_EVIDENCE_FORMAT.pptx
  ) {
    process.exitCode = 1;
    return;
  }

  const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  try {
    const payload =
      format === OFFICE_EVIDENCE_FORMAT.xlsx
        ? await extractXlsxBlocks(bytes)
        : await extractPptxBlocks(bytes);
    const result = {
      payload,
      status: "available",
    } as const satisfies OfficeEvidenceWorkerResult;
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    const result = {
      errorCode: classifyFailure(error),
      status: "unavailable",
    } as const satisfies OfficeEvidenceWorkerResult;
    process.stdout.write(JSON.stringify(result));
  }
};

await main();
