import { createElement } from "react";

import MentionExtension from "@tiptap/extension-mention";
import { mergeAttributes, ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

import { TemplateFieldMentionNode } from "@/routes/_protected.knowledge/-components/template-field-mention";
import {
  createSuggestion,
  type MentionOption,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/custom-mention";

export type TemplateFieldMentionOption = MentionOption;

/**
 * `@`-mention of another template field. The node stores the field `path`
 * as `id` and its label; `renderText` emits the `{{path}}` marker so the
 * plain-text `aiPrompt` carries a reference the backend prompt consumer can
 * resolve against the manifest, while the chip shows the human label.
 */
export const TemplateFieldMention = MentionExtension.extend({
  renderText({ node }) {
    const path = typeof node.attrs["id"] === "string" ? node.attrs["id"] : "";
    return `{{${path}}}`;
  },
  parseHTML() {
    return [{ tag: "template-field-mention" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["template-field-mention", mergeAttributes(HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer((props: NodeViewProps) =>
      createElement(TemplateFieldMentionNode, props),
    );
  },
});

export const createTemplateFieldMention = (
  fields: TemplateFieldMentionOption[],
) =>
  TemplateFieldMention.configure({
    suggestion: createSuggestion(fields),
    deleteTriggerWithBackspace: true,
  });
