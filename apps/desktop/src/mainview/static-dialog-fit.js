import { panic } from "better-result";

// Measure natural content, including the reserved title-bar inset. A change in
// wording or certificate/status details goes through the same fit operation.
/**
 * @param {(size: { width: number, height: number }) => Promise<{ maxWidth: number, maxHeight: number } | null>} resize Native caller-scoped content resize operation.
 */
export const fitStaticDialog = (resize) => {
  const element = document.querySelector(".dialog");
  if (!(element instanceof HTMLElement)) {
    panic("Static dialog markup must contain an HTML content element");
  }
  const dialog = element;
  let maxHeight = Math.min(960, screen.availHeight - 64);
  let maxWidth = Math.min(720, screen.availWidth - 64);
  /** @type {number | null} */
  let frame = null;
  let previous = "";
  const fit = async () => {
    frame = null;
    let width = Math.min(420, maxWidth);
    dialog.style.width = `${width}px`;
    while (dialog.scrollHeight > maxHeight && width < maxWidth) {
      width = Math.min(width + 60, maxWidth);
      dialog.style.width = `${width}px`;
    }
    const height = Math.ceil(dialog.getBoundingClientRect().height);
    const geometry = `${width}:${height}`;
    if (geometry === previous) {
      return;
    }
    previous = geometry;
    const bounds = await resize({ width, height });
    if (
      bounds &&
      (bounds.maxHeight !== maxHeight || bounds.maxWidth !== maxWidth)
    ) {
      maxHeight = bounds.maxHeight;
      maxWidth = bounds.maxWidth;
      previous = "";
      schedule();
    }
  };
  const schedule = () => {
    frame ??= requestAnimationFrame(() => {
      void fit();
    });
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(dialog);
  void document.fonts.ready.then(schedule);
  schedule();
  window.addEventListener(
    "pagehide",
    () => {
      observer.disconnect();
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    },
    { once: true },
  );
};
