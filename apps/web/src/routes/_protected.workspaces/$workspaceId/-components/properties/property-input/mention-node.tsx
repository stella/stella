import { cn } from "@stll/ui/lib/utils";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

export const MentionNode = (props: NodeViewProps) => {
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId",
    select: (p) => p.workspaceId,
  });
  // SAFETY: attrs from our mention extension schema
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  const attributes = props.node.attrs as {
    id: string;
    label: string;
    mentionSuggestionChar: string;
  };
  const { data: propertyName } = useSuspenseQuery({
    ...propertiesOptions(workspaceId),
    select: (data) => data.find((item) => item.id === attributes.id)?.name,
  });

  return (
    <NodeViewWrapper className="inline w-fit">
      <span
        className={cn(
          "bg-info/10 text-info-foreground rounded px-1 py-0.5 font-medium",
        )}
      >
        {propertyName ?? attributes.label}
      </span>
    </NodeViewWrapper>
  );
};
