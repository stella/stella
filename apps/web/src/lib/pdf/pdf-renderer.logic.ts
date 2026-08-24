/**
 * pdf.js signals an interrupted render three ways: the canvas render task
 * rejects with `RenderingCancelledException`, `TextLayer.cancel()` rejects
 * with its own `AbortException`, and our `signal.throwIfAborted()` throws a
 * DOM `AbortError`. None of them is a failure the viewer should surface.
 */
export type PdfCancellationClasses = {
  RenderingCancelledException: unknown;
  AbortException: unknown;
};

const isInstanceOf = (err: unknown, klass: unknown): boolean =>
  typeof klass === "function" && err instanceof klass;

export const isPdfRenderCancellation = (
  err: unknown,
  classes: PdfCancellationClasses | null,
): boolean =>
  (err instanceof Error && err.name === "AbortError") ||
  (classes !== null &&
    (isInstanceOf(err, classes.RenderingCancelledException) ||
      isInstanceOf(err, classes.AbortException)));
