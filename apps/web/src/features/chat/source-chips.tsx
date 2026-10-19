import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";

import { isEntityKind } from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";
import { Separator } from "@stll/ui/separator";
import { cn } from "@stll/ui/utils";

import { openEntityInInspector } from "@/components/chat/entity-open";
import { useExternalSourceStore } from "@/components/chat/external-source-store";
import { LegalCitationLink } from "@/components/chat/legal-citation-link";
import type { ExternalSourceEntry } from "@/components/chat/source-chips.logic";
import { collectSourceChipEntries } from "@/components/chat/source-chips.logic";
import { ReferenceIcon } from "@/components/references/reference-chip";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import type { ChatMessage, ChatSourceDocument } from "@/lib/api-contract";
import { detached } from "@/lib/detached";
import { navigateToWorkspaceFolder } from "@/lib/workspaces/reveal-navigation";

type SourceChipsProps = {
  messageId: string;
  sourceDocuments?: readonly ChatSourceDocument[] | undefined;
  parts: ChatMessage["parts"];
  workspaceId?: string | undefined;
};

export const SourceChips = ({
  messageId,
  parts,
  sourceDocuments,
  workspaceId,
}: SourceChipsProps) => {
  const { uniqueExternalSources, uniqueSources } = collectSourceChipEntries({
    parts,
    sourceDocuments,
  });
  const registerSources = useExternalSourceStore(
    (state) => state.registerSources,
  );

  // Push the derived source list into the external-source store
  // whenever it changes so the inspector can resolve cited sources.
  useExternalSyncEffect(() => {
    registerSources(uniqueExternalSources);
  }, [registerSources, uniqueExternalSources]);

  if (uniqueSources.length === 0 && uniqueExternalSources.length === 0) {
    return null;
  }

  return (
    <>
      <Separator
        className="self-stretch"
        data-chat-answer-citations-divider
        orientation="vertical"
      />
      <div className="contents" data-chat-answer-citations>
        {uniqueSources.map((part) => (
          <SourceChip
            key={`${messageId}-source-${part.id ?? part.data.entityId}`}
            sourceDocument={part.data}
            workspaceId={workspaceId}
          />
        ))}
        {uniqueExternalSources.map((source) => (
          <PublisherSourceChip
            key={`${messageId}-external-source-${source.url}`}
            source={source}
            workspaceId={workspaceId ?? null}
          />
        ))}
      </div>
    </>
  );
};

// The tray keeps its own shell, but draws each source's glyph by the shared
// reference rule, so a document here looks like the same document in the
// answer above it (kind glyph, matter colour).
const SourceIcon = ({
  sourceDocument,
  workspaceId,
}: {
  sourceDocument: ChatSourceDocument;
  workspaceId: string | undefined;
}) => (
  <ReferenceIcon
    reference={{
      type: "entity",
      entityId: sourceDocument.entityId,
      matterId: workspaceId ?? null,
      label: sourceDocument.title,
      entityKind: isEntityKind(sourceDocument.kind)
        ? sourceDocument.kind
        : null,
      mimeType: sourceDocument.mimeType,
    }}
  />
);

const PublisherSourceChip = ({
  source,
  workspaceId,
}: {
  source: ExternalSourceEntry;
  workspaceId: string | null;
}) => (
  <LegalCitationLink
    appearance="tray"
    interactive
    source={source}
    workspaceId={workspaceId}
  >
    {source.title}
  </LegalCitationLink>
);

const SourceChip = ({
  sourceDocument,
  workspaceId,
}: {
  sourceDocument: ChatSourceDocument;
  workspaceId?: string | undefined;
}) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const resolvedWorkspaceId =
    workspaceId ?? sourceDocument.workspaceId ?? undefined;

  const handleClick = () => {
    if (!resolvedWorkspaceId) {
      return;
    }

    detached(
      (async () => {
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
            queryClient,
            targetWorkspaceId: result.workspaceId,
          });
        }
      })(),
      "source-chips.open-entity-in-inspector",
    );
  };

  return (
    <button
      className={cn(
        "inline-flex max-w-full min-w-0 shrink-0 items-center gap-1 rounded-md border",
        "bg-muted/50 px-1.5 py-0.5 text-xs",
        resolvedWorkspaceId
          ? "hover:bg-muted cursor-pointer"
          : "cursor-default",
      )}
      onClick={handleClick}
      type="button"
    >
      <SourceIcon
        sourceDocument={sourceDocument}
        workspaceId={resolvedWorkspaceId}
      />
      <BidiText as="span" className="max-w-full min-w-0 truncate">
        {sourceDocument.title}
      </BidiText>
    </button>
  );
};
