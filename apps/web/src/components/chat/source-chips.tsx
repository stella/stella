import { isDataUIPart, isToolUIPart } from "ai";
import type { UIDataTypes } from "ai";
import { FileTextIcon, FolderIcon } from "lucide-react";

import type {
  ChatMessage,
  ChatPart,
  ChatSourceDocument,
} from "@stella/api/types";
import { cn } from "@stella/ui/lib/utils";

import { openEntityInInspector } from "@/components/chat/entity-link";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

type SourceDocumentPart = {
  type: "data-stella-source-document";
  data: ChatSourceDocument;
  id?: string;
  transient?: boolean;
};

type SourceDocumentEntry = {
  data: ChatSourceDocument;
  id?: string | undefined;
};

type SourceChipsProps = {
  messageId: string;
  parts: ChatMessage["parts"];
  workspaceId?: string | undefined;
};

const isSourceDocumentPart = (part: ChatPart): part is SourceDocumentPart =>
  isDataUIPart<UIDataTypes & { "stella-source-document": ChatSourceDocument }>(
    part,
  ) && part.type === "data-stella-source-document";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isChatSourceDocument = (value: unknown): value is ChatSourceDocument => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value["entityId"] === "string" &&
    typeof value["kind"] === "string" &&
    (typeof value["mimeType"] === "string" || value["mimeType"] === null) &&
    typeof value["title"] === "string" &&
    (typeof value["workspaceId"] === "string" || value["workspaceId"] === null)
  );
};

const collectSourceDocuments = (
  value: unknown,
  sources: SourceDocumentEntry[],
) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSourceDocuments(item, sources);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const sourceDocument = value["sourceDocument"];
  if (isChatSourceDocument(sourceDocument)) {
    sources.push({ data: sourceDocument });
  }

  for (const child of Object.values(value)) {
    collectSourceDocuments(child, sources);
  }
};

const getToolOutput = (part: ChatPart): unknown => {
  if (!isToolUIPart(part) || !("output" in part)) {
    return undefined;
  }

  return part.output;
};

export const SourceChips = ({
  messageId,
  parts,
  workspaceId,
}: SourceChipsProps) => {
  const sources: SourceDocumentEntry[] = [];
  for (const part of parts) {
    if (isSourceDocumentPart(part)) {
      sources.push({ data: part.data, id: part.id });
      continue;
    }

    collectSourceDocuments(getToolOutput(part), sources);
  }

  if (sources.length === 0) {
    return null;
  }

  const seen = new Set<string>();
  const uniqueSources = sources.filter(({ data }) => {
    const key = `${data.workspaceId ?? ""}:${data.entityId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return (
    <div className="flex flex-wrap gap-1">
      {uniqueSources.map((part) => (
        <SourceChip
          key={`${messageId}-source-${part.id ?? part.data.entityId}`}
          sourceDocument={part.data}
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
  sourceDocument,
  workspaceId,
}: {
  sourceDocument: ChatSourceDocument;
  workspaceId?: string | undefined;
}) => {
  const resolvedWorkspaceId =
    workspaceId ?? sourceDocument.workspaceId ?? undefined;

  const handleClick = () => {
    if (!resolvedWorkspaceId) {
      return;
    }

    openEntityInInspector(
      sourceDocument.entityId,
      sourceDocument.title,
      resolvedWorkspaceId,
    );
  };

  return (
    <button
      className={cn(
        "inline-flex items-center gap-1 rounded-md border",
        "bg-muted/50 px-1.5 py-0.5 text-xs transition-colors",
        resolvedWorkspaceId
          ? "hover:bg-muted cursor-pointer"
          : "cursor-default",
      )}
      onClick={handleClick}
      type="button"
    >
      <SourceIcon
        kind={sourceDocument.kind}
        mimeType={sourceDocument.mimeType}
      />
      <span className="max-w-[20ch] truncate">{sourceDocument.title}</span>
    </button>
  );
};
