import { sanitizeHref } from "./sanitize-href";

const ISOLATED_WINDOW_FEATURES = "noopener,noreferrer";

export const openIsolatedWindow = (href: string): void => {
  const safeHref = sanitizeHref(href);
  if (safeHref === undefined) {
    return;
  }

  window.open(safeHref, "_blank", ISOLATED_WINDOW_FEATURES);
};
