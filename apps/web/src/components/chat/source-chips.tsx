import type { SourceDocumentUIPart, UIMessage } from "ai";
import { FileTextIcon, FolderIcon } from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

import { openEntityInPeek } from "@/components/chat/entity-link";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

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

const cls = "size-3 shrink-0";

const SourceIcon = ({
  kind,
  mimeType,
}: {
  kind: string;
  mimeType: string | null;
}) => {
  if (kind === "folder") {
    return <FolderIcon className={cls} />;
  }
  if (mimeType) {
    return <DocumentIcon className={cls} mimeType={mimeType} />;
  }
  return <FileTextIcon className={cn(cls, "text-muted-foreground")} />;
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
    if (
      entityId === undefined ||
      entityId === null ||
      typeof entityId !== "string"
    ) {
      return;
    }

    openEntityInPeek(entityId, part.title);
  };

  const stella = part.providerMetadata?.stella;
  const mimeType =
    stella &&
    typeof stella === "object" &&
    "mimeType" in stella &&
    typeof stella.mimeType === "string"
      ? stella.mimeType
      : null;
  const kind =
    stella &&
    typeof stella === "object" &&
    "kind" in stella &&
    typeof stella.kind === "string"
      ? stella.kind
      : "document";

  return (
    <button
      className={cn(
        "inline-flex items-center gap-1 rounded-md border",
        "bg-muted/50 px-1.5 py-0.5 text-xs transition-colors",
        workspaceId ? "hover:bg-muted cursor-pointer" : "cursor-default",
      )}
      onClick={handleClick}
      type="button"
    >
      <SourceIcon kind={kind} mimeType={mimeType} />
      <span className="max-w-[20ch] truncate">{part.title}</span>
    </button>
  );
};
