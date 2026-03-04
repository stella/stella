import type { SourceDocumentUIPart, UIMessage } from "ai";
import { FileTextIcon } from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

import { openEntityInPeek } from "@/components/chat/entity-link";

type SourceChipsProps = {
  messageId: string;
  parts: UIMessage["parts"];
  workspaceId?: string;
};

export const SourceChips = ({
  messageId,
  parts,
  workspaceId,
}: SourceChipsProps) => {
  const sources = parts.filter(
    (p): p is SourceDocumentUIPart => p.type === "source-document",
  );

  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {sources.map((part) => (
        <SourceChip
          key={`${messageId}-source-${part.sourceId}`}
          part={part}
          workspaceId={workspaceId}
        />
      ))}
    </div>
  );
};

const SourceChip = ({
  part,
  workspaceId,
}: {
  part: SourceDocumentUIPart;
  workspaceId?: string;
}) => {
  const handleClick = () => {
    if (!workspaceId) {
      return;
    }

    const stella = part.providerMetadata?.stella;
    if (!stella || typeof stella !== "object") {
      return;
    }
    const entityId = "entityId" in stella ? stella.entityId : undefined;
    if (!entityId || typeof entityId !== "string") {
      return;
    }

    openEntityInPeek(entityId, part.title);
  };

  return (
    <button
      className={cn(
        "inline-flex items-center gap-1 rounded-md border",
        "bg-muted/50 px-1.5 py-0.5 text-xs transition-colors",
        workspaceId ? "cursor-pointer hover:bg-muted" : "cursor-default",
      )}
      onClick={handleClick}
      type="button"
    >
      <FileTextIcon className="size-3 shrink-0 text-muted-foreground" />
      <span className="max-w-[20ch] truncate">{part.title}</span>
    </button>
  );
};
