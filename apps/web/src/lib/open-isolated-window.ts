import { sanitizeHref } from "@stll/decision-reader/sanitize-href";

const ISOLATED_WINDOW_FEATURES = "noopener,noreferrer";

export const openIsolatedWindow = (href: string): void => {
  const safeHref = sanitizeHref(href);
  if (safeHref === undefined) {
    return;
  }

  window.open(safeHref, "_blank", ISOLATED_WINDOW_FEATURES);
};
