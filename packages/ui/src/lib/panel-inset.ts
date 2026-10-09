/** Shared geometry contract between docked chrome and document side panels. */
export const DOCUMENT_PANEL_BOTTOM_INSET = "--document-panel-bottom-inset";
export const DOCUMENT_PANEL_SAFE_BOTTOM =
  "max(env(safe-area-inset-bottom, 0px), var(--document-panel-bottom-inset, 0px))";

/**
 * Publish the actual occluded block-end region on the positioned host. A
 * callback ref owns observation and cleanup, so growing composer/thread chrome
 * changes every descendant panel without screen-specific padding estimates.
 */
export const publishDocumentPanelInset = (element: HTMLDivElement | null) => {
  if (!element) {
    return;
  }
  const host = element.offsetParent;
  if (!(host instanceof HTMLElement)) {
    return;
  }
  const previous = host.style.getPropertyValue(DOCUMENT_PANEL_BOTTOM_INSET);
  const measure = () => {
    const inset = Math.max(
      0,
      host.getBoundingClientRect().bottom - element.getBoundingClientRect().top,
    );
    host.style.setProperty(DOCUMENT_PANEL_BOTTOM_INSET, `${inset}px`);
  };
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  observer.observe(host);
  measure();
  return () => {
    observer.disconnect();
    if (previous) {
      host.style.setProperty(DOCUMENT_PANEL_BOTTOM_INSET, previous);
      return;
    }
    host.style.removeProperty(DOCUMENT_PANEL_BOTTOM_INSET);
  };
};
