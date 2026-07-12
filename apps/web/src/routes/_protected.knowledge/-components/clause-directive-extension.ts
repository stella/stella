import { createElement } from "react";

import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

import { BLOCK_DIRECTIVE_KINDS } from "@stll/template-conditions";

import { includesValue } from "@/lib/utils";
import { ClauseDirectiveNodeView } from "@/routes/_protected.knowledge/-components/clause-directive-node";
import type { BlockDirectiveKind } from "@/routes/_protected.knowledge/-components/directive-kinds";

/**
 * A `{{#if}}`/`{{#each}}` block directive rendered as a real, atomic editor
 * node. Keeping directives in the document (rather than stripping them and
 * re-interleaving on save) makes them visible and — crucially — keeps their
 * position true to the editor: a directive moves with the surrounding text
 * instead of being restored to a stale index. The node is non-editable; the
 * author reorders or deletes it as a whole block.
 */
export const CLAUSE_DIRECTIVE_NODE = "clauseDirective";

export const isBlockDirectiveKind = (
  value: unknown,
): value is BlockDirectiveKind =>
  typeof value === "string" && includesValue(BLOCK_DIRECTIVE_KINDS, value);

export const ClauseDirectiveNode = Node.create({
  name: CLAUSE_DIRECTIVE_NODE,
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      kind: { default: "if" },
      expression: { default: "" },
      // The original marker text, preserved verbatim so a directive round-trips
      // losslessly (the node is not edited, only repositioned).
      text: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-clause-directive]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes({ "data-clause-directive": "" }, HTMLAttributes),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer((props: NodeViewProps) =>
      createElement(ClauseDirectiveNodeView, props),
    );
  },
});
