/**
 * Dev-only PDF render performance instrumentation.
 * Logs render timing, re-render counts, and canvas
 * element counts to the console with a [PDF_PERF] prefix.
 */

const isDev = import.meta.env.DEV;

let renderCount = 0;
let lastLogTime = 0;
const LOG_INTERVAL = 2000;

export const markRenderStart = (pageId: string) => {
  if (!isDev) {
    return;
  }
  // Clear stale start marks from cancelled renders
  // so the Performance timeline stays clean.
  performance.clearMarks(`pdf-render-start:${pageId}`);
  performance.mark(`pdf-render-start:${pageId}`);
};

export const markRenderEnd = (pageId: string) => {
  if (!isDev) {
    return;
  }
  performance.mark(`pdf-render-end:${pageId}`);

  try {
    const measure = performance.measure(
      `pdf-render:${pageId}`,
      `pdf-render-start:${pageId}`,
      `pdf-render-end:${pageId}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[PDF_PERF] ${pageId} rendered in ${measure.duration.toFixed(1)}ms`,
    );
  } catch {
    // Marks may have been cleared
  }

  renderCount++;
  const now = Date.now();
  if (now - lastLogTime > LOG_INTERVAL) {
    const canvasCount = document.querySelectorAll("canvas").length;
    // eslint-disable-next-line no-console
    console.log(
      `[PDF_PERF] Stats: ${renderCount} renders, ${canvasCount} canvases`,
    );
    lastLogTime = now;
  }
};
