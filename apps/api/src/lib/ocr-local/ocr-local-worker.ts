/**
 * Isolated local OCR worker.
 *
 * Runs as a standalone Bun subprocess. Receives the model directory as a
 * CLI argument and raw PDF bytes on stdin; writes recognized page geometry
 * as JSON to stdout. The parent enforces a hard timeout and revalidates
 * the output shape, so a crashed or misbehaving worker can never corrupt
 * a run.
 *
 * Pages are processed strictly one at a time: render, detect, recognize,
 * release. Combined with the per-run process lifetime this bounds memory
 * regardless of document size; page count and render size are capped
 * before any model runs.
 *
 * Usage:  bun run ocr-local-worker.ts <modelDir>
 *   stdin  → raw PDF bytes
 *   stdout → JSON { pages: [{ width, height, lines: [...] }] }
 *   exit 0 = success, exit 1 = OCR error
 */

import { PDFiumLibrary } from "@hyzyla/pdfium";
import path from "node:path";
import * as ort from "onnxruntime-node";

import {
  OCR_LOCAL_MODEL_FILES,
  OCR_MAX_PAGES,
  OCR_RENDER_MAX_SIDE_PIXELS,
  OCR_RENDER_TARGET_SCALE,
  type DocumentOcrLine,
  type DocumentOcrPage,
} from "@/api/lib/document-processing-contract";
import { buildOcrPage } from "@/api/lib/document-processing-ocr-result";
import {
  buildCtcDecodeTable,
  compareReadingOrder,
  decodeCtc,
  detInputSize,
  extractTextBoxes,
  normalizeDetInput,
  packRecCrop,
  REC_BATCH_SIZE,
  REC_INPUT_HEIGHT,
  REC_MAX_INPUT_WIDTH,
  type TextBox,
} from "@/api/lib/ocr-local/ppocr-pipeline";
import { resizeRgbRegion, rgbaToRgb } from "@/api/lib/ocr-local/rgb-image";

const MIN_LINE_CONFIDENCE = 0.05;

const die = (message: string): never => {
  process.stderr.write(`ocr-local-worker error: ${message}\n`);
  process.exit(1);
};

const modelDir = process.argv[2] ?? die("model directory argument is required");

const sessionOptions: ort.InferenceSession.SessionOptions = {
  enableCpuMemArena: false,
  enableMemPattern: false,
};
const [detSession, recSession, dictionary] = await Promise.all([
  ort.InferenceSession.create(
    path.join(modelDir, OCR_LOCAL_MODEL_FILES.detection),
    sessionOptions,
  ),
  ort.InferenceSession.create(
    path.join(modelDir, OCR_LOCAL_MODEL_FILES.recognition),
    sessionOptions,
  ),
  Bun.file(path.join(import.meta.dir, "latin-v5-dict.txt")).text(),
]);
const decodeTable = buildCtcDecodeTable(dictionary);

type RenderedPage = {
  data: Uint8Array;
  width: number;
  height: number;
  /** Rendered pixels per PDF point on each axis. */
  scaleX: number;
  scaleY: number;
  pointWidth: number;
  pointHeight: number;
};

const detect = async (page: RenderedPage): Promise<TextBox[]> => {
  const size = detInputSize({ width: page.width, height: page.height });
  const resized = resizeRgbRegion({
    data: page.data,
    width: page.width,
    height: page.height,
    targetWidth: size.width,
    targetHeight: size.height,
  });
  const pixelCount = size.width * size.height;
  const input = normalizeDetInput(resized, pixelCount);
  const output = await detSession.run({
    [detSession.inputNames[0] ?? "x"]: new ort.Tensor("float32", input, [
      1,
      3,
      size.height,
      size.width,
    ]),
  });
  const prob = output[detSession.outputNames[0] ?? ""]?.data;
  if (!(prob instanceof Float32Array)) {
    return die("detection model produced no float output");
  }
  return extractTextBoxes({
    prob,
    probWidth: size.width,
    probHeight: size.height,
    sourceWidth: page.width,
    sourceHeight: page.height,
  });
};

const recognize = async (
  page: RenderedPage,
  boxes: TextBox[],
): Promise<DocumentOcrLine[]> => {
  const ratios = boxes.map((box) => (box.x1 - box.x0) / (box.y1 - box.y0));
  const order = ratios
    .map((_, index) => index)
    .sort((a, b) => (ratios[a] ?? 0) - (ratios[b] ?? 0));
  const lines: (DocumentOcrLine | null)[] = boxes.map(() => null);

  const recognizeBatch = async (start: number): Promise<void> => {
    if (start >= order.length) {
      return;
    }
    const batch = order.slice(start, start + REC_BATCH_SIZE);
    const maxRatio = Math.max(...batch.map((index) => ratios[index] ?? 1));
    const batchWidth = Math.min(
      REC_MAX_INPUT_WIDTH,
      Math.max(1, Math.ceil(REC_INPUT_HEIGHT * maxRatio)),
    );
    const tensor = new Float32Array(
      batch.length * 3 * REC_INPUT_HEIGHT * batchWidth,
    );
    const packBatchCrop = async (bi: number): Promise<void> => {
      if (bi >= batch.length) {
        return;
      }
      const boxIndex = batch[bi] ?? 0;
      const box = boxes[boxIndex];
      if (!box) {
        await packBatchCrop(bi + 1);
        return;
      }
      const cropWidth = Math.min(
        batchWidth,
        Math.max(1, Math.round(REC_INPUT_HEIGHT * (ratios[boxIndex] ?? 1))),
      );
      const crop = resizeRgbRegion({
        data: page.data,
        width: page.width,
        height: page.height,
        left: box.x0,
        top: box.y0,
        regionWidth: box.x1 - box.x0,
        regionHeight: box.y1 - box.y0,
        targetWidth: cropWidth,
        targetHeight: REC_INPUT_HEIGHT,
      });
      packRecCrop({
        batchIndex: bi,
        batchWidth,
        crop,
        cropWidth,
        tensor,
      });
      await packBatchCrop(bi + 1);
    };

    await packBatchCrop(0);
    const output = await recSession.run({
      [recSession.inputNames[0] ?? "x"]: new ort.Tensor("float32", tensor, [
        batch.length,
        3,
        REC_INPUT_HEIGHT,
        batchWidth,
      ]),
    });
    const logits = output[recSession.outputNames[0] ?? ""];
    const data = logits?.data;
    if (!logits || !(data instanceof Float32Array)) {
      return die("recognition model produced no float output");
    }
    const [count, steps, classes] = logits.dims;
    if (
      count === undefined ||
      steps === undefined ||
      classes === undefined ||
      count !== batch.length
    ) {
      return die("recognition model produced an unexpected shape");
    }
    for (let bi = 0; bi < count; bi += 1) {
      const boxIndex = batch[bi] ?? 0;
      const box = boxes[boxIndex];
      if (!box) {
        continue;
      }
      const decoded = decodeCtc({
        classes,
        data,
        offset: bi * steps * classes,
        steps,
        table: decodeTable,
      });
      const text = decoded.text.trim();
      if (!text || decoded.confidence < MIN_LINE_CONFIDENCE) {
        continue;
      }
      const confidence = Math.min(1, Math.max(0, decoded.confidence));
      lines[boxIndex] = {
        box: [
          box.x0 / page.scaleX,
          box.y0 / page.scaleY,
          box.x1 / page.scaleX,
          box.y1 / page.scaleY,
        ],
        confidence: Number(confidence.toFixed(4)),
        text,
      };
    }
    await recognizeBatch(start + REC_BATCH_SIZE);
  };

  await recognizeBatch(0);

  const orderedBoxes = boxes
    .map((box, index) => ({ box, line: lines[index] }))
    .filter(
      (entry): entry is { box: TextBox; line: DocumentOcrLine } =>
        entry.line !== null && entry.line !== undefined,
    );
  orderedBoxes.sort((a, b) => compareReadingOrder(a.box, b.box));
  return orderedBoxes.map((entry) => entry.line);
};

// ── Main ──────────────────────────────────────────────────

try {
  const pdfBytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  const library = await PDFiumLibrary.init();
  const document = await library.loadDocument(Buffer.from(pdfBytes));
  const pageCount = document.getPageCount();
  if (pageCount < 1 || pageCount > OCR_MAX_PAGES) {
    die(`page count ${pageCount} is outside the supported range`);
  }

  const processPage = async (index: number): Promise<DocumentOcrPage> => {
    const page = document.getPage(index);
    const { originalHeight: pointHeight, originalWidth: pointWidth } =
      page.getOriginalSize();
    const scale = Math.min(
      OCR_RENDER_TARGET_SCALE,
      OCR_RENDER_MAX_SIDE_PIXELS / Math.max(pointWidth, pointHeight),
    );
    const render = await page.render({ scale });
    const rgb = rgbaToRgb({
      data: render.data,
      width: render.width,
      height: render.height,
    });
    const rendered: RenderedPage = {
      data: rgb,
      width: render.width,
      height: render.height,
      scaleX: render.width / pointWidth,
      scaleY: render.height / pointHeight,
      pointWidth,
      pointHeight,
    };
    const boxes = await detect(rendered);
    const lines = await recognize(rendered, boxes);
    return buildOcrPage({ lines, pointHeight, pointWidth });
  };

  const pages: DocumentOcrPage[] = [];
  const processPages = async (index: number): Promise<void> => {
    if (index >= pageCount) {
      return;
    }
    pages.push(await processPage(index));
    await processPages(index + 1);
  };
  await processPages(0);
  document.destroy();
  library.destroy();

  process.stdout.write(JSON.stringify({ pages }));
  process.exit(0);
} catch (error) {
  // Only the error type reaches stderr: messages could carry recognized
  // document text, which must not enter application logs.
  const type = error instanceof Error ? error.constructor.name : "UnknownError";
  die(type);
}
