import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { toPlainText } from "./plain-text";

type RenderedEmail = {
  html: string;
  text: string;
};

/**
 * Renders an email built from `../components` to its HTML and plain-text
 * parts. The HTML carries the XHTML 1.0 Transitional doctype email clients
 * expect; the plain text is derived from the same markup.
 */
export const renderEmail = (email: React.ReactElement): RenderedEmail => {
  const markup = renderToStaticMarkup(email).replaceAll(IMAGE_PRELOAD, "");
  return {
    html: `${XHTML_DOCTYPE}${markup}`,
    text: toPlainText(markup),
  };
};

const XHTML_DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';

// React hoists a preload hint for every `<img>` into `<head>`. Browsers use
// it to fetch early; email clients ignore it, so it is only noise.
const IMAGE_PRELOAD = /<link rel="preload" as="image" href="[^"]*"\/>/gu;
