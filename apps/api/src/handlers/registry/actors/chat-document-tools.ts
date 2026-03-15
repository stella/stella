/**
 * Tool that lets the model choose which revision view of an
 * attached DOCX to display to the user. Only registered when
 * the message includes extracted-text attachments.
 */

import type { ToolSet } from "ai";
import { z } from "zod";

import type { ExtractedTextAttachment } from "./chat-attachment-types";
import { defineTool } from "./chat-tools";

type ViewsMap = ExtractedTextAttachment["views"];

const VIEW_KEYS = {
  simple: "simple",
  original: "original",
  "tracked-changes": "trackedChanges",
} as const satisfies Record<string, keyof ViewsMap>;

export const createDocumentViewTools = (
  attachments: ExtractedTextAttachment[],
): ToolSet => ({
  displayDocument: defineTool({
    name: "displayDocument",
    // oxfmt-ignore
    description: `Display an uploaded document to the user in a specific view. Use 'simple' for clean accepted text, 'original' for the pre-edit version, 'tracked-changes' for the full redline with annotations. Available files: ${attachments.map((a) => a.filename).join(", ")}`,
    inputSchema: z.object({
      view: z.enum(["simple", "original", "tracked-changes"]),
      filename: z.string(),
    }),
    execute: ({ view, filename }) => {
      const att = attachments.find((a) => a.filename === filename);
      if (!att) {
        return { error: "File not found" };
      }

      const viewKey = VIEW_KEYS[view] ?? "simple";
      const text = att.views[viewKey] ?? att.views.simple;
      return { filename, view, text };
    },
  }),
});
