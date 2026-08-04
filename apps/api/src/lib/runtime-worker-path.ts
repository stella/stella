import path from "node:path";

const WORKER_DIR_ENV = "STELLA_WORKER_DIR";
const OCR_PDF_FONT_PATH_ENV = "STELLA_OCR_PDF_FONT_PATH";

export const resolveRuntimeWorkerPath = ({
  outputFile,
  sourceDir,
  sourceFile,
}: {
  outputFile: string;
  sourceDir: string;
  sourceFile: string;
}): string => {
  const workerDir = process.env[WORKER_DIR_ENV];
  if (workerDir) {
    return path.resolve(workerDir, outputFile);
  }

  return path.resolve(sourceDir, sourceFile);
};

export const resolveOcrPdfFontPath = (localPath: string): string =>
  process.env[OCR_PDF_FONT_PATH_ENV] || localPath;
