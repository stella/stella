import { useSuspenseQuery } from "@tanstack/react-query";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

import { cn } from "@stll/ui/lib/utils";

import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

type MentionNodeProps = NodeViewProps & {
  workspaceId: string;
};

type MentionAttrs = {
  id: string;
  label: string;
  mentionSuggestionChar: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readMentionAttrs = (value: unknown): MentionAttrs => {
  if (!isRecord(value)) {
    return { id: "", label: "", mentionSuggestionChar: "@" };
  }

  const id = value["id"];
  const label = value["label"];
  const mentionSuggestionChar = value["mentionSuggestionChar"];

  return {
    id: typeof id === "string" ? id : "",
    label: typeof label === "string" ? label : "",
    mentionSuggestionChar:
      typeof mentionSuggestionChar === "string" ? mentionSuggestionChar : "@",
  };
};

export const MentionNode = ({ workspaceId, ...props }: MentionNodeProps) => {
  const attributes = readMentionAttrs(props.node.attrs);
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
