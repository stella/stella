import runtime from "./generated/runtime.js.txt" with { type: "text" };
import { escapeVisualJson } from "./srcdoc";

export const VISUAL_INNER_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
].join("; ");

export const visualOuterPolicy = (origins: readonly string[]) =>
  `${VISUAL_INNER_POLICY}; frame-ancestors ${origins.join(" ")}`;

export const visualOuterDocument = (origins: readonly string[]) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><style>html,body{margin:0;width:100%;height:100%;background:transparent}body{display:flex}iframe{flex:1;width:100%;height:100%;border:0;background:transparent}</style></head><body><script id="visual-config" type="application/json">${escapeVisualJson({ origins, policy: VISUAL_INNER_POLICY })}</script><script>${runtime}</script></body></html>`;
