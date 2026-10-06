import type { SanitizedVisualHtml } from "./sanitize";

const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const escapeVisualJson = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");

// The trusted bundle contains document-composer string literals. Preserve
// their JavaScript values while avoiding HTML script-parser delimiters.
export const escapeVisualScript = (source: string) =>
  source.replace(/<\/script|<!--/giu, (match) => `\\u003c${match.slice(1)}`);

type ComposeVisualDocumentOptions = {
  html: SanitizedVisualHtml;
  runtime: string;
  policy: string;
};

export const composeVisualDocument = ({
  html,
  runtime,
  policy,
}: ComposeVisualDocumentOptions) =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>${runtime}</script></head><body>${html}</body></html>`;
