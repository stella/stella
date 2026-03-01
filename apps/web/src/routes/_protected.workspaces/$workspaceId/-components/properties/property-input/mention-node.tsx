import { useSuspenseQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";

import { cn } from "@stella/ui/lib/utils";

import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

export const MentionNode = (props: NodeViewProps) => {
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId",
    select: (p) => p.workspaceId,
  });
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
          "rounded bg-info/10 px-1 py-0.5 font-medium text-info-foreground",
        )}
      >
        {propertyName ?? attributes.label}
      </span>
    </NodeViewWrapper>
  );
};
