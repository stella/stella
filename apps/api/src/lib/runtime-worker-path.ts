import path from "node:path";

const WORKER_DIR_ENV = "STELLA_WORKER_DIR";

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
