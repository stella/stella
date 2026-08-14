/**
 * End-to-end test of the local OCR worker subprocess on a synthetic PDF
 * with known text. Requires the pinned ONNX models, so it skips on a
 * checkout that has not run `bun run ocr:fetch-models`; the image build
 * additionally spawns the bundled worker in its smoke stage, which keeps
 * the shipped artifact covered even where this suite skips.
 */

import { PDF, StandardFonts } from "@libpdf/core";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { OCR_LOCAL_MODEL_FILES } from "@/api/lib/document-processing-contract";
import { parseOcrPage } from "@/api/lib/document-processing-ocr-result";

const MODEL_DIR = path.resolve(import.meta.dir, "../../../ocr-models");
const WORKER_PATH = path.resolve(import.meta.dir, "ocr-local-worker.ts");

const modelsPresent = await Promise.all(
  Object.values(OCR_LOCAL_MODEL_FILES).map(
    async (file) => await Bun.file(path.join(MODEL_DIR, file)).exists(),
  ),
).then((results) => results.every(Boolean));

const buildTextPdf = async (): Promise<Uint8Array> => {
  const pdf = PDF.create();
  const font = StandardFonts.Helvetica;
  const first = pdf.addPage({ width: 612, height: 792 });
  first.drawText("Smlouva o dilo 2026", { x: 72, y: 700, size: 24, font });
  first.drawText("Rechnung Nr 4711", { x: 72, y: 640, size: 24, font });
  const second = pdf.addPage({ width: 612, height: 792 });
  second.drawText("Second page heading", { x: 72, y: 700, size: 24, font });
  return await pdf.save();
};

const runWorker = async (pdfBytes: Uint8Array): Promise<string> => {
  const subprocess = Bun.spawn(["bun", "run", WORKER_PATH, MODEL_DIR], {
    stdin: new Blob([pdfBytes.slice().buffer]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);
  expect(exitCode).toBe(0);
  return output;
};

describe.skipIf(!modelsPresent)("ocr-local-worker", () => {
  test("recognizes synthetic text and repeated runs are byte-identical", async () => {
    const pdfBytes = await buildTextPdf();
    const first = await runWorker(pdfBytes);
    const second = await runWorker(pdfBytes);

    // Idempotence: identical input bytes produce identical output bytes.
    expect(second).toBe(first);

    const parsed: unknown = JSON.parse(first);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("pages" in parsed) ||
      !Array.isArray(parsed.pages)
    ) {
      throw new Error("worker output is not a pages object");
    }
    const pages = parsed.pages.map((page: unknown) => parseOcrPage(page));
    expect(pages.length).toBe(2);
    for (const page of pages) {
      expect(page).not.toBeNull();
      expect(page?.width).toBe(612);
      expect(page?.height).toBe(792);
    }

    const text = pages
      .flatMap((page) => page?.lines.map((line) => line.text) ?? [])
      .join("\n");
    expect(text).toContain("Smlouva o dilo 2026");
    expect(text).toContain("Rechnung Nr 4711");
    expect(text).toContain("Second page heading");
    const confidences = pages.flatMap(
      (page) => page?.lines.map((line) => line.confidence) ?? [],
    );
    expect(confidences.length).toBeGreaterThan(0);
    expect(Math.min(...confidences)).toBeGreaterThan(0.5);
  }, 120_000);

  test("rejects a non-PDF input with a failure exit code", async () => {
    const subprocess = Bun.spawn(["bun", "run", WORKER_PATH, MODEL_DIR], {
      stdin: new Blob([new TextEncoder().encode("not a pdf")]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await subprocess.exited).toBe(1);
  }, 60_000);
});
