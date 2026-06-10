import { createElement } from "react";

import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

import { BLOCK_DIRECTIVE_KINDS } from "@stll/template-conditions";
import { cn } from "@stll/ui/lib/utils";

import {
  CONDITIONAL_KINDS,
  DirectiveLabel,
} from "@/routes/_protected.knowledge/-components/paragraph-rendering";
import type { BlockDirectiveKind } from "@/routes/_protected.knowledge/-components/paragraph-rendering";

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
  typeof value === "string" &&
  (BLOCK_DIRECTIVE_KINDS as readonly string[]).includes(value);

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

const ClauseDirectiveNodeView = ({ node }: NodeViewProps) => {
  const kind = isBlockDirectiveKind(node.attrs["kind"])
    ? node.attrs["kind"]
    : "if";
  const expression =
    typeof node.attrs["expression"] === "string"
      ? node.attrs["expression"]
      : "";
  const isConditional = CONDITIONAL_KINDS.has(kind);

  return (
    <NodeViewWrapper
      className={cn(
        "clause-directive my-0.5 cursor-grab rounded-sm border-s-[3px] py-1.5 ps-3 pe-2 select-none",
        isConditional
          ? "border-foreground-disabled bg-accent/50 dark:border-foreground-disabled dark:bg-accent/30"
          : "border-success/40 bg-success/10 dark:border-success/40 dark:bg-success/10",
      )}
      contentEditable={false}
      data-drag-handle
    >
      <DirectiveLabel expression={expression} kind={kind} />
    </NodeViewWrapper>
  );
};
