/**
 * The declaration file the compiler emits for a source, given the source's
 * path already moved under the output directory. TypeScript 7 has no `outFile`,
 * so every source has its own declaration.
 */
export const declarationOutputName = (source: string): string =>
  source.replace(/\.(?:[jt]sx?|[mc][jt]s)$/u, (extension) => {
    if (extension === ".mts" || extension === ".mjs") {
      return ".d.mts";
    }
    if (extension === ".cts" || extension === ".cjs") {
      return ".d.cts";
    }
    return ".d.ts";
  });
