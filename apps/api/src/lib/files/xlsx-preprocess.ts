import { Result } from "better-result";

import { loadDocxArchive } from "@/api/lib/docx-archive";

const REGEX_HAS_PAGE_SET_UP_PR = /<pageSetUpPr[\s/>]/u;
const REGEX_EXTRACT_PAGE_SET_UP_PR = /<pageSetUpPr(?<attrs>[^/]*?)\/>/gu;
const REGEX_REMOVE_FIT_TO_PAGE = /(?<!\s)\s*fitToPage="[^"]*"/u;
const REGEX_HAS_OPEN_SHEET_PR = /<sheetPr[^>]*>[\s\S]*?<\/sheetPr>/u;
const REGEX_EXTRACT_OPEN_SHEET_PR =
  /(?<open><sheetPr[^>]*>)(?<inner>[\s\S]*?)(?<close><\/sheetPr>)/u;
const REGEX_HAS_SELF_CLOSING_SHEET_PR = /<sheetPr[^>]*\/>/u;
const REGEX_EXTRACT_SELF_CLOSING_SHEET_PR = /<sheetPr(?<attrs>[^>]*?)\/>/u;
const REGEX_SHEET_LANDMARK =
  /<(?:dimension|sheetViews|sheetFormatPr|sheetData)[\s/>]/u;
const REGEX_WORKSHEET_OPEN = /<worksheet[^>]*>/u;
const REGEX_HAS_PAGE_SETUP = /<pageSetup[\s/>]/u;
const REGEX_EXTRACT_PAGE_SETUP = /<pageSetup(?<attrs>[^/]*?)\/>/gu;
const REGEX_REMOVE_SCALE = /(?<!\s)\s*scale="[^"]*"/u;
const REGEX_REMOVE_FIT_TO_WIDTH = /(?<!\s)\s*fitToWidth="[^"]*"/u;
const REGEX_REMOVE_FIT_TO_HEIGHT = /(?<!\s)\s*fitToHeight="[^"]*"/u;
const REGEX_WORKSHEET_CLOSE = /<\/worksheet>/u;
const REGEX_SHEET_FILENAME = /^xl\/worksheets\/sheet\d+\.xml$/u;

/**
 * Patch a single worksheet XML string to enable "fit all
 * columns to one page" print scaling.
 *
 * Rules applied:
 * - `<sheetPr>` gets a `<pageSetUpPr fitToPage="1"/>` child
 *   (inserted or updated).
 * - `<pageSetup>` gets `fitToWidth="1" fitToHeight="0"` and has
 *   any `scale` attribute removed. If absent it is appended
 *   before `</worksheet>`.
 */
export const patchSheetXml = (xml: string): string => {
  let out = xml;

  // ── sheetPr / pageSetUpPr ───────────────────────────────

  const hasPageSetUpPr = REGEX_HAS_PAGE_SET_UP_PR.test(out);

  if (hasPageSetUpPr) {
    // Update existing element: ensure fitToPage="1"
    out = out.replace(REGEX_EXTRACT_PAGE_SET_UP_PR, (_, attrs: string) => {
      const cleaned = attrs.replace(REGEX_REMOVE_FIT_TO_PAGE, "").trim();
      return `<pageSetUpPr${cleaned ? ` ${cleaned}` : ""} fitToPage="1"/>`;
    });
  } else {
    const hasOpenSheetPr = REGEX_HAS_OPEN_SHEET_PR.test(out);

    if (hasOpenSheetPr) {
      // Insert pageSetUpPr inside existing open sheetPr
      out = out.replace(
        REGEX_EXTRACT_OPEN_SHEET_PR,
        (_, open: string, inner: string, close: string) =>
          `${open}${inner}<pageSetUpPr fitToPage="1"/>${close}`,
      );
    } else if (REGEX_HAS_SELF_CLOSING_SHEET_PR.test(out)) {
      // Handle self-closing <sheetPr ... />
      out = out.replace(
        REGEX_EXTRACT_SELF_CLOSING_SHEET_PR,
        (_, attrs: string) =>
          `<sheetPr${attrs}><pageSetUpPr fitToPage="1"/></sheetPr>`,
      );
    } else {
      // No sheetPr — insert before the first known landmark element,
      // or just after the opening <worksheet> tag.
      const anchor = out.search(REGEX_SHEET_LANDMARK);
      if (anchor !== -1) {
        out = `${out.slice(0, anchor)}<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${out.slice(anchor)}`;
      } else {
        // As a last resort, just insert after <worksheet> open tag
        out = out.replace(
          REGEX_WORKSHEET_OPEN,
          (match) => `${match}<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`,
        );
      }
    }
  }

  // ── pageSetup ───────────────────────────────────────────

  const hasPageSetup = REGEX_HAS_PAGE_SETUP.test(out);

  if (hasPageSetup) {
    // Update existing element: set fitToWidth/fitToHeight, remove scale
    out = out.replace(REGEX_EXTRACT_PAGE_SETUP, (_, attrs: string) => {
      const a = attrs
        .replace(REGEX_REMOVE_SCALE, "")
        .replace(REGEX_REMOVE_FIT_TO_WIDTH, "")
        .replace(REGEX_REMOVE_FIT_TO_HEIGHT, "")
        .trim();
      return `<pageSetup${a ? ` ${a}` : ""} fitToWidth="1" fitToHeight="0"/>`;
    });
  } else {
    // Append before </worksheet>
    out = out.replace(
      REGEX_WORKSHEET_CLOSE,
      '<pageSetup fitToWidth="1" fitToHeight="0"/></worksheet>',
    );
  }

  return out;
};

/**
 * Pre-process an XLSX/XLS buffer before handing it to Gotenberg.
 * Injects "fit all columns to one page wide" print settings into
 * every worksheet so LibreOffice does not tile wide spreadsheets
 * across multiple pages.
 *
 * Sheet XML is inflated through the bounded archive reader, so the patch is a
 * print-layout nicety that can never decompress more than the archive caps
 * allow. Returns the original buffer unchanged when:
 * - The buffer is not a valid ZIP (e.g. legacy binary .xls)
 * - The archive is outside the decompression caps
 * - The ZIP does not contain `xl/workbook.xml` (not an OOXML file)
 */
export const applyFitToPage = async (
  buffer: ArrayBuffer,
): Promise<ArrayBuffer> => {
  const loaded = await Result.tryPromise(
    async () => await loadDocxArchive(buffer),
  );
  if (Result.isError(loaded)) {
    return buffer;
  }

  const archive = loaded.value;
  const { zip } = archive;

  // Guard: must be an OOXML spreadsheet
  if (!zip.file("xl/workbook.xml")) {
    return buffer;
  }

  const sheetPaths = Object.keys(zip.files).filter((p) =>
    REGEX_SHEET_FILENAME.test(p),
  );

  const sheets = await Result.tryPromise(
    async () =>
      await Promise.all(
        sheetPaths.map(async (path) => ({
          path,
          xml: await archive.readEntryString(path),
        })),
      ),
  );
  if (Result.isError(sheets)) {
    return buffer;
  }

  for (const { path, xml } of sheets.value) {
    if (xml === null) {
      continue;
    }
    zip.file(path, patchSheetXml(xml));
  }

  return await zip.generateAsync({ type: "arraybuffer" });
};
