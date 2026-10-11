/**
 * Some publisher rows put a complete HTML body in `plain_text`. Require a
 * structural root enclosing another structural element before reading it as
 * HTML: prose quoting tags, escaped tags and OCR angle brackets stay literal.
 */
const STRUCTURAL_ROOT =
  /^<(div|article|section|main|body|html|pre|p)(?=[\s>])/iu;
const TAG = /<\/?([a-z][a-z0-9]*)(?=[\s/>])[^<>]*>/giu;
const STRUCTURAL_TAGS = new Set([
  "div",
  "article",
  "section",
  "main",
  "body",
  "html",
  "pre",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
]);

export const plainTextStructureOf = (text: string): "plain" | "html" => {
  const body = text.trim();
  const root = STRUCTURAL_ROOT.exec(body)?.at(1)?.toLowerCase();
  if (root === undefined || !body.toLowerCase().endsWith(`</${root}>`)) {
    return "plain";
  }
  let structuralElements = 0;
  for (const match of body.matchAll(TAG)) {
    const name = match.at(1)?.toLowerCase();
    if (
      !match[0].startsWith("</") &&
      name !== undefined &&
      STRUCTURAL_TAGS.has(name)
    ) {
      structuralElements += 1;
      if (structuralElements > 1) {
        return "html";
      }
    }
  }
  return "plain";
};
