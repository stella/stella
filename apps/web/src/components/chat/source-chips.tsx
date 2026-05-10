import { useEffect, useMemo } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { getToolName, isDataUIPart, isToolUIPart } from "ai";
import type { UIDataTypes } from "ai";
import { ExternalLinkIcon, FileTextIcon, FolderIcon } from "lucide-react";

import type {
  ChatMessage,
  ChatPart,
  ChatSourceDocument,
} from "@stll/api/types";
import { cn } from "@stll/ui/lib/utils";

import { openEntityInInspector } from "@/components/chat/entity-open";
import { useExternalSourceStore } from "@/components/chat/external-source-store";
import { navigateToWorkspaceFolder } from "@/components/chat/folder-navigation";
import type {
  ExternalSourceEntry,
  SourceDocumentEntry,
} from "@/components/chat/source-chips.logic";
import {
  collectExternalSources,
  collectSourceDocuments,
} from "@/components/chat/source-chips.logic";
import { sanitizeHref } from "@/lib/sanitize-href";
import { mcpConnectorsOptions } from "@/routes/_protected.knowledge/-queries";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

type SourceDocumentPart = {
  type: "data-stella-source-document";
  data: ChatSourceDocument;
  id?: string;
  transient?: boolean;
};

type SourceChipsProps = {
  messageId: string;
  parts: ChatMessage["parts"];
  workspaceId?: string | undefined;
};

type ToolPart = Parameters<typeof getToolName>[0];

type McpToolInfo = {
  connectorSlug: string;
  sourceToolName: string;
};

const isSourceDocumentPart = (part: ChatPart): part is SourceDocumentPart =>
  isDataUIPart<UIDataTypes & { "stella-source-document": ChatSourceDocument }>(
    part,
  ) && part.type === "data-stella-source-document";

const getToolOutput = (part: ChatPart): unknown => {
  if (!isToolUIPart(part) || !("output" in part)) {
    return undefined;
  }

  return part.output;
};

const getMcpToolInfo = (part: ToolPart): McpToolInfo | null => {
  const sourceToolName = getToolName(part);
  if (!sourceToolName.startsWith("mcp__")) {
    return null;
  }

  const [, connectorSlug, ...toolParts] = sourceToolName.split("__");
  if (!connectorSlug || toolParts.length === 0) {
    return null;
  }

  return { connectorSlug, sourceToolName };
};

export const SourceChips = ({
  messageId,
  parts,
  workspaceId,
}: SourceChipsProps) => {
  const { uniqueExternalSources, uniqueSources } = useMemo(
    () => collectSourceChipEntries(parts),
    [parts],
  );
  const hasMcpExternalSources = uniqueExternalSources.some(
    (source) => source.connectorSlug !== undefined,
  );
  const { data: mcpConnectorsData } = useQuery({
    ...mcpConnectorsOptions(),
    enabled: hasMcpExternalSources,
  });
  const uniqueExternalSourcesWithIcons = useMemo(
    () =>
      uniqueExternalSources.map((source) => {
        if (source.connectorSlug === undefined) {
          return source;
        }

        const iconHref = findMcpConnectorIconHref({
          connectorSlug: source.connectorSlug,
          connectors: mcpConnectorsData?.connectors ?? [],
        });
        return iconHref === undefined ? source : { ...source, iconHref };
      }),
    [mcpConnectorsData?.connectors, uniqueExternalSources],
  );
  const registerSources = useExternalSourceStore(
    (state) => state.registerSources,
  );

  useEffect(() => {
    registerSources(uniqueExternalSourcesWithIcons);
  }, [registerSources, uniqueExternalSourcesWithIcons]);

  if (uniqueSources.length === 0 && uniqueExternalSources.length === 0) {
    return null;
  }

  return (
    <div className="flex max-w-full flex-nowrap gap-1 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {uniqueSources.map((part) => (
        <SourceChip
          key={`${messageId}-source-${part.id ?? part.data.entityId}`}
          sourceDocument={part.data}
          workspaceId={workspaceId}
        />
      ))}
      {uniqueExternalSourcesWithIcons.map((source) => (
        <ExternalSourceChip
          key={`${messageId}-external-source-${source.url}`}
          source={source}
        />
      ))}
    </div>
  );
};

const collectSourceChipEntries = (
  parts: ChatMessage["parts"],
): {
  uniqueExternalSources: ExternalSourceEntry[];
  uniqueSources: SourceDocumentEntry[];
} => {
  const sources: SourceDocumentEntry[] = [];
  const externalSources: ExternalSourceEntry[] = [];
  for (const part of parts) {
    if (isSourceDocumentPart(part)) {
      sources.push({ data: part.data, id: part.id });
      continue;
    }

    if (!isToolUIPart(part)) {
      continue;
    }

    const toolOutput = getToolOutput(part);
    collectSourceDocuments(toolOutput, sources);
    const mcpToolInfo = getMcpToolInfo(part);
    const toolExternalSources: ExternalSourceEntry[] = [];
    collectExternalSources(toolOutput, toolExternalSources);
    for (const source of toolExternalSources) {
      externalSources.push({
        ...source,
        connectorSlug: source.connectorSlug ?? mcpToolInfo?.connectorSlug,
        sourceToolName: source.sourceToolName ?? mcpToolInfo?.sourceToolName,
      });
    }
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
  const externalSourcesByUrl = new Map<string, ExternalSourceEntry>();
  for (const source of externalSources) {
    const existing = externalSourcesByUrl.get(source.url);
    externalSourcesByUrl.set(
      source.url,
      existing
        ? {
            connectorSlug: source.connectorSlug ?? existing.connectorSlug,
            iconHref: source.iconHref ?? existing.iconHref,
            provider: source.provider ?? existing.provider,
            snippet: source.snippet ?? existing.snippet,
            sourceToolName: source.sourceToolName ?? existing.sourceToolName,
            text: source.text ?? existing.text,
            title: source.title,
            url: source.url,
          }
        : source,
    );
  }

  return {
    uniqueExternalSources: Array.from(externalSourcesByUrl.values()),
    uniqueSources,
  };
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

const ExternalSourceChip = ({ source }: { source: ExternalSourceEntry }) => {
  const handleClick = () => {
    useInspectorStore.getState().openExternal({
      connectorSlug: source.connectorSlug,
      iconHref: source.iconHref,
      label: source.title,
      provider: source.provider,
      snippet: source.snippet,
      sourceToolName: source.sourceToolName,
      text: source.text,
      url: source.url,
    });
  };

  return (
    <button
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border",
        "bg-muted/50 px-1.5 py-0.5 text-xs transition-colors",
        "hover:bg-muted cursor-pointer",
      )}
      onClick={handleClick}
      type="button"
    >
      <ExternalSourceIcon iconHref={source.iconHref} />
      <span className="max-w-[20ch] truncate">{source.title}</span>
    </button>
  );
};

const ExternalSourceIcon = ({
  iconHref,
}: {
  iconHref?: string | undefined;
}) => {
  if (iconHref) {
    return (
      <span className="bg-background flex size-3 shrink-0 items-center justify-center rounded-[2px] border">
        <img
          alt=""
          className="size-2.5 rounded-[1px] object-contain"
          height={10}
          src={iconHref}
          width={10}
        />
      </span>
    );
  }

  return <ExternalLinkIcon className={cn(cls, "text-muted-foreground")} />;
};

const SourceChip = ({
  sourceDocument,
  workspaceId,
}: {
  sourceDocument: ChatSourceDocument;
  workspaceId?: string | undefined;
}) => {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const resolvedWorkspaceId =
    workspaceId ?? sourceDocument.workspaceId ?? undefined;

  const handleClick = () => {
    if (!resolvedWorkspaceId) {
      return;
    }

    void (async () => {
      const result = await openEntityInInspector(
        sourceDocument.entityId,
        sourceDocument.title,
        resolvedWorkspaceId,
      );

      if (result.type === "folder") {
        await navigateToWorkspaceFolder({
          folderId: result.entityId,
          navigate,
          pathname,
          targetWorkspaceId: result.workspaceId,
        });
      }
    })();
  };

  return (
    <button
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border",
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

const findMcpConnectorIconHref = ({
  connectorSlug,
  connectors,
}: {
  connectorSlug: string;
  connectors: {
    iconUrl: string | null;
    slug: string;
    url: string;
  }[];
}): string | undefined => {
  const connector = connectors.find(
    (item) => sanitizeMcpToolNamePart(item.slug) === connectorSlug,
  );
  if (!connector) {
    return undefined;
  }

  const iconHref = connector.iconUrl ?? fallbackIconUrl(connector.url);
  return iconHref === undefined ? undefined : sanitizeHref(iconHref);
};

const sanitizeMcpToolNamePart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");

const fallbackIconUrl = (rawUrl: string): string | undefined => {
  try {
    return new URL("/favicon.ico", rawUrl).toString();
  } catch {
    return undefined;
  }
};
