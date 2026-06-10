import { createElement } from "react";

import MentionExtension from "@tiptap/extension-mention";
import { mergeAttributes, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

import { cn } from "@stll/ui/lib/utils";

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

export const createTemplateFieldMention = (fields: TemplateFieldMentionOption[]) =>
  TemplateFieldMention.configure({
    suggestion: createSuggestion(fields),
    deleteTriggerWithBackspace: true,
  });

const TemplateFieldMentionNode = (props: NodeViewProps) => {
  const label =
    typeof props.node.attrs["label"] === "string"
      ? props.node.attrs["label"]
      : "";
  const path =
    typeof props.node.attrs["id"] === "string" ? props.node.attrs["id"] : "";

  return (
    <NodeViewWrapper className="inline w-fit">
      <span
        className={cn(
          "bg-info/10 text-info-foreground rounded px-1 py-0.5 font-medium",
        )}
      >
        {label || path}
      </span>
    </NodeViewWrapper>
  );
};
