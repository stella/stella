/**
 * Sandboxed searchable-PDF worker.
 *
 * stdin: four-byte big-endian JSON length, OCR payload JSON, source PDF bytes
 * stdout: source PDF with an invisible OCR text layer
 */

import { PDF } from "@libpdf/core";
import { TaggedError } from "better-result";

import type {
  DocumentOcrLine,
  DocumentOcrPayload,
} from "@/api/lib/document-processing-contract";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const INPUT_HEADER_BYTES = 4;

class OcrSearchablePdfWorkerError extends TaggedError(
  "OcrSearchablePdfWorkerError",
)<{ message: string; cause?: unknown }> {}

const fail = (message: string): never => {
  throw new OcrSearchablePdfWorkerError({ message });
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isOcrBox = (
  value: unknown,
  width: number,
  height: number,
): value is DocumentOcrLine["box"] => {
  if (!isUnknownArray(value) || value.length !== 4) {
    return false;
  }
  const [xMin, yMin, xMax, yMax] = value;
  return (
    isFiniteNumber(xMin) &&
    isFiniteNumber(yMin) &&
    isFiniteNumber(xMax) &&
    isFiniteNumber(yMax) &&
    xMin >= 0 &&
    yMin >= 0 &&
    xMax > xMin &&
    yMax > yMin &&
    xMax <= width &&
    yMax <= height
  );
};

const isOcrLine = (
  value: unknown,
  width: number,
  height: number,
): value is DocumentOcrLine => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["text"] === "string" &&
    isFiniteNumber(value["confidence"]) &&
    value["confidence"] >= 0 &&
    value["confidence"] <= 1 &&
    isOcrBox(value["box"], width, height)
  );
};

const isOcrPayload = (value: unknown): value is DocumentOcrPayload => {
  if (!isRecord(value)) {
    return false;
  }
  if (value["version"] !== 1 || !Array.isArray(value["pages"])) {
    return false;
  }
  return value["pages"].every((page) => {
    if (!isRecord(page)) {
      return false;
    }
    const width = page["width"];
    const height = page["height"];
    return (
      isFiniteNumber(width) &&
      isFiniteNumber(height) &&
      width > 0 &&
      height > 0 &&
      Array.isArray(page["lines"]) &&
      page["lines"].every((line) => isOcrLine(line, width, height))
    );
  });
};

const parseInput = (
  input: Uint8Array,
): { payload: DocumentOcrPayload; source: Uint8Array } => {
  if (input.byteLength <= INPUT_HEADER_BYTES) {
    fail("Invalid searchable-PDF worker input");
  }
  const payloadLength = new DataView(
    input.buffer,
    input.byteOffset,
    INPUT_HEADER_BYTES,
  ).getUint32(0);
  const payloadEnd = INPUT_HEADER_BYTES + payloadLength;
  if (
    payloadLength === 0 ||
    payloadLength > LIMITS.documentOcrPayloadMaxBytes ||
    payloadEnd >= input.byteLength ||
    input.byteLength - payloadEnd > FILE_SIZE_LIMIT_BYTES.document
  ) {
    fail("Invalid searchable-PDF payload length");
  }
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(input.subarray(INPUT_HEADER_BYTES, payloadEnd)),
  );
  if (!isOcrPayload(parsed)) {
    return fail("Invalid searchable-PDF OCR payload");
  }
  return { payload: parsed, source: input.subarray(payloadEnd) };
};

const pageHasNativeText = (page: ReturnType<PDF["getPages"]>[number]) =>
  page.extractText().lines.some((line) => line.text.trim().length > 0);

try {
  const fontPath =
    process.argv.at(2) ?? fail("Searchable-PDF font is not configured");
  const { payload, source } = parseInput(
    new Uint8Array(await Bun.stdin.arrayBuffer()),
  );
  const pdf = await PDF.load(source);
  const pages = pdf.getPages();
  if (pages.length !== payload.pages.length) {
    fail("OCR page count does not match source PDF");
  }
  const font = pdf.embedFont(await Bun.file(fontPath).bytes());

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const ocrPage = payload.pages[pageIndex];
    if (!page || !ocrPage || pageHasNativeText(page)) {
      continue;
    }
    const scaleX = page.width / ocrPage.width;
    const scaleY = page.height / ocrPage.height;
    for (const line of ocrPage.lines) {
      const text = line.text.normalize("NFC");
      if (!font.canEncode(text)) {
        continue;
      }
      const [xMin, yMin, xMax, yMax] = line.box;
      const targetWidth = (xMax - xMin) * scaleX;
      const targetHeight = (yMax - yMin) * scaleY;
      const size = Math.min(
        font.sizeAtHeight(targetHeight),
        font.sizeAtWidth(text, targetWidth),
      );
      if (!Number.isFinite(size) || size <= 0) {
        continue;
      }
      page.drawText(text, {
        font,
        opacity: 0,
        size,
        x: xMin * scaleX,
        y: page.height - yMax * scaleY,
      });
    }
  }

  const output = Buffer.from(await pdf.save({ subsetFonts: true }));
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) {
        reject(
          new OcrSearchablePdfWorkerError({
            message: "Failed to write searchable PDF output",
            cause: error,
          }),
        );
        return;
      }
      resolve();
    });
  });
} catch (error) {
  const type = error instanceof Error ? error.constructor.name : "UnknownError";
  process.stderr.write(`ocr-searchable-pdf-worker error: ${type}\n`);
  process.exit(1);
}
