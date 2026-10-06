import { VISUAL_GUEST_MARKER_ATTRIBUTE } from "@stll/api-contract/visual-sandbox";
import { VISUAL_DATA_SCRIPT_ID } from "@stll/api-contract/generated-visual";

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
  data: unknown;
  runtime: string;
  policy: string;
};

export const composeVisualDocument = ({
  html,
  data,
  runtime,
  policy,
}: ComposeVisualDocumentOptions) =>
  `<!doctype html><html ${VISUAL_GUEST_MARKER_ATTRIBUTE}><head><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script type="application/json" id="${VISUAL_DATA_SCRIPT_ID}">${escapeVisualJson(data)}</script><script>${runtime}</script></head><body>${html}</body></html>`;
