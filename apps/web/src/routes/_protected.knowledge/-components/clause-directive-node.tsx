import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

import { BLOCK_DIRECTIVE_KINDS } from "@stll/template-conditions";
import { cn } from "@stll/ui/lib/utils";

import { CONDITIONAL_KINDS } from "@/routes/_protected.knowledge/-components/directive-kinds";
import type { BlockDirectiveKind } from "@/routes/_protected.knowledge/-components/directive-kinds";
import { DirectiveLabel } from "@/routes/_protected.knowledge/-components/paragraph-rendering";

// Mirrors `isBlockDirectiveKind` in `clause-directive-extension.ts`. Kept
// private and duplicated here (rather than imported) so this component
// module has no dependency back on the extension module, which itself
// imports this component for `addNodeView`.
const isBlockDirectiveKind = (value: unknown): value is BlockDirectiveKind =>
  typeof value === "string" &&
  BLOCK_DIRECTIVE_KINDS.some((kind) => kind === value);

export const ClauseDirectiveNodeView = ({ node }: NodeViewProps) => {
  const kind = isBlockDirectiveKind(node.attrs["kind"])
    ? node.attrs["kind"]
    : "if";
  const expression =
    typeof node.attrs["expression"] === "string"
      ? node.attrs["expression"]
      : "";
  const isConditional = CONDITIONAL_KINDS.includes(kind);

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
