import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";

import { isEntityKind } from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";
import { ExternalLinkIcon } from "@stll/ui/icons";
import { Separator } from "@stll/ui/separator";
import { cn } from "@stll/ui/utils";

import { openEntityInInspector } from "@/components/chat/entity-open";
import { useExternalSourceStore } from "@/components/chat/external-source-store";
import { LegalCitationLink } from "@/components/chat/legal-citation-link";
import { findMcpConnectorIconHref } from "@/components/chat/mcp-connector-icon";
import type { ExternalSourceEntry } from "@/components/chat/source-chips.logic";
import { collectSourceChipEntries } from "@/components/chat/source-chips.logic";
import { ReferenceIcon } from "@/components/references/reference-chip";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import type { ChatMessage, ChatSourceDocument } from "@/lib/api-contract";
import { detached } from "@/lib/detached";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { useQueryView } from "@/lib/use-query-view";
import { navigateToWorkspaceFolder } from "@/lib/workspaces/reveal-navigation";

type SourceChipsProps = {
  activeOrganizationId: string;
  messageId: string;
  sourceDocuments?: readonly ChatSourceDocument[] | undefined;
  parts: ChatMessage["parts"];
  workspaceId?: string | undefined;
};

export const SourceChips = ({
  activeOrganizationId,
  messageId,
  parts,
  sourceDocuments,
  workspaceId,
}: SourceChipsProps) => {
  const { uniqueExternalSources, uniqueSources } = collectSourceChipEntries({
    parts,
    sourceDocuments,
  });
  const hasMcpExternalSources = uniqueExternalSources.some(
    (source) => source.connectorSlug !== undefined,
  );
  const mcpConnectorsQuery = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled: hasMcpExternalSources,
  });
  const connectorsView = useQueryView(mcpConnectorsQuery);
  // Connector reads only decorate sources with icons; the source and approval stay usable without them.
  const availableConnectors =
    connectorsView.type === "items" ? connectorsView.items.connectors : [];
  const uniqueExternalSourcesWithIcons = uniqueExternalSources.map((source) => {
    if (source.connectorSlug === undefined) {
      return source;
    }

    const iconHref = findMcpConnectorIconHref({
      connectorSlug: source.connectorSlug,
      connectors: availableConnectors,
    });
    return iconHref === undefined ? source : { ...source, iconHref };
  });
  const registerSources = useExternalSourceStore(
    (state) => state.registerSources,
  );

  // Push the derived source list into the external-source store
  // whenever it changes so the inspector can resolve cited sources.
  useExternalSyncEffect(() => {
    registerSources(uniqueExternalSourcesWithIcons);
  }, [registerSources, uniqueExternalSourcesWithIcons]);

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
        {uniqueExternalSourcesWithIcons.map((source) => (
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

const cls = "size-3 shrink-0";

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
}) => {
  // Defer the favicon GET until the user actively hovers/focuses
  // this chip — passive renders of a chat message must not fan out
  // requests to every cited host.
  const [faviconRequested, setFaviconRequested] = useState(false);
  const revealFavicon = () => setFaviconRequested(true);
  return (
    <LegalCitationLink
      appearance="tray"
      externalIcon={
        <ExternalSourceIcon
          iconHref={source.iconHref}
          loaded={faviconRequested}
          url={source.sourceUrl ?? source.url}
        />
      }
      interactive
      onFocus={revealFavicon}
      onMouseEnter={revealFavicon}
      source={source}
      workspaceId={workspaceId}
    >
      {source.title}
    </LegalCitationLink>
  );
};

const ExternalSourceIcon = ({
  iconHref,
  loaded,
  url,
}: {
  iconHref?: string | undefined;
  loaded: boolean;
  url?: string | undefined;
}) => {
  if (iconHref) {
    return (
      <span className="bg-background flex size-3 shrink-0 items-center justify-center rounded-xs border">
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

  return <SourceFavicon loaded={loaded} url={url} />;
};

type SourceFaviconProps = {
  url: string | undefined;
  /**
   * The favicon image only mounts when this flag flips to `true`;
   * the parent chip owns the flag and flips it on hover/focus so
   * passively viewing a message does not GET every cited host. See
   * the per-message rationale in `streamdown-mention-link.tsx`.
   */
  loaded: boolean;
};

const SourceFavicon = ({ url, loaded }: SourceFaviconProps) => {
  const [errored, setErrored] = useState(false);
  const hostname = (() => {
    if (!url) {
      return null;
    }
    try {
      return new URL(url).hostname.replace(/^www\./u, "");
    } catch {
      return null;
    }
  })();
  if (!hostname || errored || !loaded) {
    return <ExternalLinkIcon className={cn(cls, "text-muted-foreground")} />;
  }
  return (
    <img
      alt=""
      aria-hidden="true"
      className="border-border size-3 shrink-0 rounded-full border object-contain"
      loading="lazy"
      onError={() => setErrored(true)}
      referrerPolicy="no-referrer"
      src={`https://${hostname}/favicon.ico`}
    />
  );
};

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
