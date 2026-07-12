import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

import { cn } from "@stll/ui/lib/utils";

export const TemplateFieldMentionNode = (props: NodeViewProps) => {
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
