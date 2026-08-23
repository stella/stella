import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { loadNativeAnonymizeBinding } from "@stll/anonymize";

import { decodePdfInspection } from "./native-codec";
import type {
  PdfGlyphObservation,
  PdfPageObservation,
  PdfRasterProvider,
} from "./types";

const LOCAL_PROVIDER_ID = "poppler-tesseract-local";
const PROCESS_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const PDF_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024;
const PDF_RASTER_MAX_PAGE_BYTES = 128 * 1024 * 1024;
const PDF_RASTER_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const PDF_MAX_PAGES = 10_000;
const PDF_MAX_GLYPHS = 5_000_000;
const PDF_MAX_OBSERVED_TEXT_UTF8_BYTES = 64 * 1024 * 1024;
const DEFAULT_DPI = 300;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_DPI = 72;
const MAX_DPI = 600;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;
const LANGUAGE_PACK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const TEMP_PREFIX = "stella-anonymize-pdf-";

export const PDF_LOCAL_PROVIDER_ERROR_CODES = {
  cleanupFailed: "cleanup-failed",
  executableFailed: "executable-failed",
  invalidOptions: "invalid-options",
  invalidOutput: "invalid-output",
  limitExceeded: "limit-exceeded",
  sourceRejected: "source-rejected",
} as const;

export type PdfLocalProviderErrorCode =
  (typeof PDF_LOCAL_PROVIDER_ERROR_CODES)[keyof typeof PDF_LOCAL_PROVIDER_ERROR_CODES];

export class PdfLocalProviderError extends Error {
  readonly code: PdfLocalProviderErrorCode;

  constructor(code: PdfLocalProviderErrorCode, message: string) {
    super(message);
    this.name = "PdfLocalProviderError";
    this.code = code;
  }
}

export type RenderPdfWithPopplerTesseractOptions = {
  document: Uint8Array;
  /** One explicit installed Tesseract traineddata name, for example `eng`. */
  ocrLanguage: string;
  dpi?: number | undefined;
  pdftoppmPath?: string | undefined;
  tesseractPath?: string | undefined;
  timeoutMs?: number | undefined;
};

export type LocalPdfRasterPage = {
  observation: PdfPageObservation;
  widthPixels: number;
  heightPixels: number;
  pixels: Uint8Array;
};

export type LocalPdfRasterObservation = {
  provider: PdfRasterProvider;
  pages: readonly LocalPdfRasterPage[];
};

type ResolvedLocalProviderOptions = {
  dpi: number;
  ocrLanguage: string;
  pdftoppmPath: string;
  tesseractPath: string;
  timeoutMs: number;
};

type ProcessResult = { stdout: Buffer; stderr: Buffer };

const providerError = (
  code: PdfLocalProviderErrorCode,
  message: string,
): PdfLocalProviderError =>
  new PdfLocalProviderError(code, `${code}: ${message}`);

const validateOptions = (
  options: RenderPdfWithPopplerTesseractOptions,
): ResolvedLocalProviderOptions => {
  const dpi = options.dpi ?? DEFAULT_DPI;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pdftoppmPath = options.pdftoppmPath ?? "pdftoppm";
  const tesseractPath = options.tesseractPath ?? "tesseract";
  if (
    !Number.isInteger(dpi) ||
    dpi < MIN_DPI ||
    dpi > MAX_DPI ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS ||
    !LANGUAGE_PACK_PATTERN.test(options.ocrLanguage) ||
    !pdftoppmPath ||
    pdftoppmPath.includes("\0") ||
    !tesseractPath ||
    tesseractPath.includes("\0")
  ) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOptions,
      "local PDF provider options are invalid",
    );
  }
  return {
    dpi,
    ocrLanguage: options.ocrLanguage,
    pdftoppmPath,
    tesseractPath,
    timeoutMs,
  };
};

const runExecutable = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  stage: "OCR" | "renderer" | "version probe",
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "buffer",
        maxBuffer: PROCESS_OUTPUT_MAX_BYTES,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            providerError(
              PDF_LOCAL_PROVIDER_ERROR_CODES.executableFailed,
              `local PDF ${stage} failed`,
            ),
          );
          return;
        }
        resolve({ stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
      },
    );
  });

const decodeUtf8 = (value: Uint8Array, context: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
      `local PDF ${context} is not valid UTF-8`,
    );
  }
};

const versionFrom = (
  value: Uint8Array,
  prefix: string,
  context: string,
): string => {
  const line = decodeUtf8(value, context).split(/\r?\n/u, 1)[0]?.trim();
  const version = line?.startsWith(prefix)
    ? line.slice(prefix.length).trim()
    : "";
  if (!version || version.length > 256 || /\p{Cc}/u.test(version)) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
      `local PDF ${context} is invalid`,
    );
  }
  return version;
};

type InspectedPageGeometry = {
  heightPoints: number;
  widthPoints: number;
};

const inspectPageGeometry = (
  document: Uint8Array,
): readonly InspectedPageGeometry[] => {
  if (document.byteLength > PDF_DOCUMENT_MAX_BYTES) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.limitExceeded,
      "PDF source exceeds its byte limit",
    );
  }
  const inspect = loadNativeAnonymizeBinding().inspectPdfJson;
  if (inspect === undefined) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.sourceRejected,
      "native PDF inspection is unavailable",
    );
  }
  try {
    const inspection = decodePdfInspection(inspect(document));
    if (
      inspection.encrypted === true ||
      inspection.pageCount < 1 ||
      inspection.pageCount > PDF_MAX_PAGES
    ) {
      throw new Error("source rejected");
    }
    return inspection.pages.map(({ heightPoints, widthPoints }) => ({
      heightPoints,
      widthPoints,
    }));
  } catch {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.sourceRejected,
      "PDF source is unsupported by the local raster provider",
    );
  }
};

const assertProjectedRasterLimits = (
  pages: readonly InspectedPageGeometry[],
  dpi: number,
): void => {
  let totalBytes = 0;
  for (const { heightPoints, widthPoints } of pages) {
    const widthPixels = Math.ceil((widthPoints * dpi) / 72);
    const heightPixels = Math.ceil((heightPoints * dpi) / 72);
    const pageBytes = widthPixels * heightPixels * 3;
    totalBytes += pageBytes;
    if (
      !Number.isSafeInteger(widthPixels) ||
      !Number.isSafeInteger(heightPixels) ||
      widthPixels <= 0 ||
      heightPixels <= 0 ||
      !Number.isSafeInteger(pageBytes) ||
      pageBytes > PDF_RASTER_MAX_PAGE_BYTES ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > PDF_RASTER_MAX_TOTAL_BYTES
    ) {
      throw providerError(
        PDF_LOCAL_PROVIDER_ERROR_CODES.limitExceeded,
        "PDF page geometry exceeds the selected DPI raster limits",
      );
    }
  }
};

type PpmPage = {
  width: number;
  height: number;
  pixels: Uint8Array;
};

const isWhitespace = (byte: number): boolean =>
  byte === 0x09 ||
  byte === 0x0a ||
  byte === 0x0b ||
  byte === 0x0c ||
  byte === 0x0d ||
  byte === 0x20;

const ppmToken = (bytes: Uint8Array, start: number): [string, number] => {
  let offset = start;
  while (offset < bytes.length) {
    if (isWhitespace(bytes[offset] ?? -1)) {
      offset += 1;
      continue;
    }
    if (bytes[offset] === 0x23) {
      while (offset < bytes.length && bytes[offset] !== 0x0a) offset += 1;
      continue;
    }
    break;
  }
  const tokenStart = offset;
  while (
    offset < bytes.length &&
    !isWhitespace(bytes[offset] ?? -1) &&
    bytes[offset] !== 0x23
  ) {
    offset += 1;
  }
  if (tokenStart === offset) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
      "Poppler emitted an invalid PPM header",
    );
  }
  const token = Buffer.from(bytes.subarray(tokenStart, offset)).toString(
    "ascii",
  );
  if (!/^[\x21-\x7e]+$/u.test(token)) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
      "Poppler emitted an invalid PPM header",
    );
  }
  return [token, offset];
};

const parsePositiveInteger = (value: string): number => {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
      "Poppler emitted invalid PPM dimensions",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.limitExceeded,
      "Poppler PPM dimensions exceed their limit",
    );
  }
  return parsed;
};

const parsePpm = (bytes: Uint8Array): PpmPage => {
  const [magic, afterMagic] = ppmToken(bytes, 0);
  const [widthValue, afterWidth] = ppmToken(bytes, afterMagic);
  const [heightValue, afterHeight] = ppmToken(bytes, afterWidth);
  const [maximumValue, afterMaximum] = ppmToken(bytes, afterHeight);
  if (magic !== "P6" || maximumValue !== "255") {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
      "Poppler must emit binary RGB8 PPM pages",
    );
  }
  const width = parsePositiveInteger(widthValue);
  const height = parsePositiveInteger(heightValue);
  const expected = width * height * 3;
  if (!Number.isSafeInteger(expected) || expected > PDF_RASTER_MAX_PAGE_BYTES) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.limitExceeded,
      "Poppler page pixels exceed their byte limit",
    );
  }
  let pixelOffset = afterMaximum;
  if (!isWhitespace(bytes[pixelOffset] ?? -1)) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
      "Poppler emitted an invalid PPM pixel separator",
    );
  }
  const separator = bytes[pixelOffset];
  pixelOffset += 1;
  if (separator === 0x0d && bytes[pixelOffset] === 0x0a) pixelOffset += 1;
  if (bytes.length - pixelOffset !== expected) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
      "Poppler emitted a truncated or trailing PPM page",
    );
  }
  return { width, height, pixels: bytes.subarray(pixelOffset) };
};

const boundedRenderedPage = async (path: string): Promise<PpmPage> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
      "Poppler page output must be a regular file",
    );
  }
  if (metadata.size > PDF_RASTER_MAX_PAGE_BYTES + 1024 * 1024) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.limitExceeded,
      "Poppler page output exceeds its byte limit",
    );
  }
  return parsePpm(await readFile(path));
};

const integerTsvField = (value: string | undefined): number => {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
      "Tesseract emitted invalid TSV geometry",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.limitExceeded,
      "Tesseract TSV geometry exceeds its limit",
    );
  }
  return parsed;
};

const parseTesseractTsv = (
  bytes: Uint8Array,
  page: PpmPage,
  pageGeometry: InspectedPageGeometry,
  pageIndex: number,
): PdfPageObservation => {
  const lines = decodeUtf8(bytes, "Tesseract TSV").split(/\r?\n/u);
  const header = lines.shift()?.split("\t");
  if (
    header?.slice(0, 12).join("\t") !==
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext"
  ) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
      "Tesseract emitted an unsupported TSV header",
    );
  }
  const { heightPoints, widthPoints } = pageGeometry;
  const glyphs: PdfGlyphObservation[] = [];
  let text = "";
  let previousLine = "";
  for (const line of lines) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields[0] !== "5") continue;
    const word = fields.slice(11).join("\t").trim();
    if (!word) continue;
    if (/\p{Cc}/u.test(word)) {
      throw providerError(
        PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
        "Tesseract emitted control characters in OCR text",
      );
    }
    const lineKey = `${fields[2] ?? ""}/${fields[3] ?? ""}/${fields[4] ?? ""}`;
    if (text) text += lineKey === previousLine ? " " : "\n";
    previousLine = lineKey;
    const start = text.length;
    text += word;
    const end = text.length;
    const left = integerTsvField(fields[6]);
    const top = integerTsvField(fields[7]);
    const width = integerTsvField(fields[8]);
    const height = integerTsvField(fields[9]);
    const right = left + width;
    const bottom = top + height;
    if (
      width === 0 ||
      height === 0 ||
      !Number.isSafeInteger(right) ||
      !Number.isSafeInteger(bottom) ||
      right > page.width ||
      bottom > page.height
    ) {
      throw providerError(
        PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOutput,
        "Tesseract emitted out-of-page OCR geometry",
      );
    }
    glyphs.push({
      start,
      end,
      bounds: {
        left: (left * widthPoints) / page.width,
        bottom: heightPoints - (bottom * heightPoints) / page.height,
        right: (right * widthPoints) / page.width,
        top: heightPoints - (top * heightPoints) / page.height,
      },
      source: "ocr",
    });
    if (glyphs.length > PDF_MAX_GLYPHS) {
      throw providerError(
        PDF_LOCAL_PROVIDER_ERROR_CODES.limitExceeded,
        "Tesseract OCR glyph count exceeds its limit",
      );
    }
    if (Buffer.byteLength(text, "utf8") > PDF_MAX_OBSERVED_TEXT_UTF8_BYTES) {
      throw providerError(
        PDF_LOCAL_PROVIDER_ERROR_CODES.limitExceeded,
        "Tesseract OCR text exceeds its byte limit",
      );
    }
  }
  return {
    pageIndex,
    widthPoints,
    heightPoints,
    text,
    glyphs,
    rendered: true,
    textLayer: "absent",
    ocr: "complete",
    imageCount: 0,
  };
};

const safeCleanup = async (directory: string): Promise<void> => {
  const expectedPrefix = `${tmpdir()}${sep}${TEMP_PREFIX}`;
  if (!directory.startsWith(expectedPrefix)) {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.cleanupFailed,
      "local PDF temporary directory could not be verified",
    );
  }
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw providerError(
        PDF_LOCAL_PROVIDER_ERROR_CODES.cleanupFailed,
        "local PDF temporary directory could not be verified",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof PdfLocalProviderError) throw error;
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.cleanupFailed,
      "local PDF temporary directory could not be inspected",
    );
  }
  try {
    await rm(directory, { force: true, recursive: true });
  } catch {
    throw providerError(
      PDF_LOCAL_PROVIDER_ERROR_CODES.cleanupFailed,
      "local PDF temporary files could not be removed",
    );
  }
};

export const renderPdfWithPopplerTesseract = async (
  options: RenderPdfWithPopplerTesseractOptions,
): Promise<LocalPdfRasterObservation> => {
  const resolved = validateOptions(options);
  const pageGeometry = inspectPageGeometry(options.document);
  assertProjectedRasterLimits(pageGeometry, resolved.dpi);
  const pageCount = pageGeometry.length;
  const popplerVersionResult = await runExecutable(
    resolved.pdftoppmPath,
    ["-v"],
    resolved.timeoutMs,
    "version probe",
  );
  const tesseractVersionResult = await runExecutable(
    resolved.tesseractPath,
    ["--version"],
    resolved.timeoutMs,
    "version probe",
  );
  const rendererVersion = versionFrom(
    popplerVersionResult.stderr.length > 0
      ? popplerVersionResult.stderr
      : popplerVersionResult.stdout,
    "pdftoppm version ",
    "Poppler version",
  );
  const ocrVersion = versionFrom(
    tesseractVersionResult.stdout.length > 0
      ? tesseractVersionResult.stdout
      : tesseractVersionResult.stderr,
    "tesseract ",
    "Tesseract version",
  );
  const directory = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const sourcePath = join(directory, "source.pdf");
    const outputPrefix = join(directory, "page");
    await writeFile(sourcePath, options.document, { flag: "wx", mode: 0o600 });
    const pages: LocalPdfRasterPage[] = [];
    let totalPixels = 0;
    let totalGlyphs = 0;
    let totalObservedTextUtf8Bytes = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const inspectedGeometry = pageGeometry.at(pageNumber - 1);
      if (inspectedGeometry === undefined) {
        throw providerError(
          PDF_LOCAL_PROVIDER_ERROR_CODES.sourceRejected,
          "PDF page geometry became unavailable",
        );
      }
      const pageOutputPrefix = `${outputPrefix}-${pageNumber}`;
      const pagePath = `${pageOutputPrefix}.ppm`;
      await runExecutable(
        resolved.pdftoppmPath,
        [
          "-cropbox",
          "-f",
          String(pageNumber),
          "-l",
          String(pageNumber),
          "-singlefile",
          "-r",
          String(resolved.dpi),
          sourcePath,
          pageOutputPrefix,
        ],
        resolved.timeoutMs,
        "renderer",
      );
      try {
        const page = await boundedRenderedPage(pagePath);
        totalPixels += page.pixels.byteLength;
        if (
          !Number.isSafeInteger(totalPixels) ||
          totalPixels > PDF_RASTER_MAX_TOTAL_BYTES
        ) {
          throw providerError(
            PDF_LOCAL_PROVIDER_ERROR_CODES.limitExceeded,
            "Poppler page pixels exceed their aggregate limit",
          );
        }
        const ocr = await runExecutable(
          resolved.tesseractPath,
          [pagePath, "stdout", "-l", resolved.ocrLanguage, "tsv"],
          resolved.timeoutMs,
          "OCR",
        );
        const observation = parseTesseractTsv(
          ocr.stdout,
          page,
          inspectedGeometry,
          pageNumber - 1,
        );
        totalGlyphs += observation.glyphs.length;
        totalObservedTextUtf8Bytes += Buffer.byteLength(
          observation.text,
          "utf8",
        );
        if (
          !Number.isSafeInteger(totalGlyphs) ||
          totalGlyphs > PDF_MAX_GLYPHS ||
          !Number.isSafeInteger(totalObservedTextUtf8Bytes) ||
          totalObservedTextUtf8Bytes > PDF_MAX_OBSERVED_TEXT_UTF8_BYTES
        ) {
          throw providerError(
            PDF_LOCAL_PROVIDER_ERROR_CODES.limitExceeded,
            "Tesseract OCR document output exceeds its aggregate limit",
          );
        }
        pages.push({
          observation,
          widthPixels: page.width,
          heightPixels: page.height,
          pixels: page.pixels,
        });
      } finally {
        await unlink(pagePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return;
          throw providerError(
            PDF_LOCAL_PROVIDER_ERROR_CODES.cleanupFailed,
            "local PDF page raster could not be removed",
          );
        });
      }
    }
    return {
      provider: {
        providerId: LOCAL_PROVIDER_ID,
        rendererName: "Poppler pdftoppm",
        rendererVersion,
        ocrName: "Tesseract OCR",
        ocrVersion,
        ocrLanguage: resolved.ocrLanguage,
      },
      pages,
    };
  } finally {
    await safeCleanup(directory);
  }
};
