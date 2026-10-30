import { serializeOuter } from "parse5";
import { adapter } from "parse5-htmlparser2-tree-adapter";

import { load } from "./load";
import type { AnyNode } from "./nodes";

export const EMAIL_PREVIEW_DOM_OPTIONS = Object.freeze({
  scriptingEnabled: false,
  treeAdapter: adapter,
});

export const loadEmailDocument = (html: string) =>
  load(html, EMAIL_PREVIEW_DOM_OPTIONS);

export const serializeEmailNode = (node: AnyNode) =>
  serializeOuter(node, EMAIL_PREVIEW_DOM_OPTIONS);

export const serializeEmailPreviewMarkup = (
  $: ReturnType<typeof loadEmailDocument>,
) => {
  const html = $("html").get(0);
  return html ? serializeEmailNode(html) : "";
};
