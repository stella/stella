import JSZip from "jszip";

const REGEX_HAS_PAGE_SET_UP_PR = /<pageSetUpPr[\s/>]/;
const REGEX_EXTRACT_PAGE_SET_UP_PR = /<pageSetUpPr([^/]*?)\/>/g;
const REGEX_REMOVE_FIT_TO_PAGE = /\s*fitToPage="[^"]*"/;
const REGEX_HAS_OPEN_SHEET_PR = /<sheetPr[^>]*>[\s\S]*?<\/sheetPr>/;
const REGEX_EXTRACT_OPEN_SHEET_PR = /(<sheetPr[^>]*>)([\s\S]*?)(<\/sheetPr>)/;
const REGEX_HAS_SELF_CLOSING_SHEET_PR = /<sheetPr[^>]*\/>/;
const REGEX_EXTRACT_SELF_CLOSING_SHEET_PR = /<sheetPr([^>]*?)\/>/;
const REGEX_SHEET_LANDMARK =
  /<(?:dimension|sheetViews|sheetFormatPr|sheetData)[\s/>]/;
const REGEX_WORKSHEET_OPEN = /<worksheet[^>]*>/;
const REGEX_HAS_PAGE_SETUP = /<pageSetup[\s/>]/;
const REGEX_EXTRACT_PAGE_SETUP = /<pageSetup([^/]*?)\/>/g;
const REGEX_REMOVE_SCALE = /\s*scale="[^"]*"/;
const REGEX_REMOVE_FIT_TO_WIDTH = /\s*fitToWidth="[^"]*"/;
const REGEX_REMOVE_FIT_TO_HEIGHT = /\s*fitToHeight="[^"]*"/;
const REGEX_WORKSHEET_CLOSE = /<\/worksheet>/;
const REGEX_SHEET_FILENAME = /^xl\/worksheets\/sheet\d+\.xml$/;

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
 * Returns the original buffer unchanged when:
 * - The buffer is not a valid ZIP (e.g. legacy binary .xls)
 * - The ZIP does not contain `xl/workbook.xml` (not an OOXML file)
 */
export const applyFitToPage = async (
  buffer: ArrayBuffer,
): Promise<ArrayBuffer> => {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    // Not a ZIP — likely a legacy binary .xls; return as-is
    return buffer;
  }

  // Guard: must be an OOXML spreadsheet
  if (!zip.file("xl/workbook.xml")) {
    return buffer;
  }

  const sheetPaths = Object.keys(zip.files).filter((p) =>
    REGEX_SHEET_FILENAME.test(p),
  );

  await Promise.all(
    sheetPaths.map(async (path) => {
      const entry = zip.file(path);
      if (!entry) {
        return;
      }
      const xml = await entry.async("string");
      zip.file(path, patchSheetXml(xml));
    }),
  );

  return zip.generateAsync({ type: "arraybuffer" });
};
