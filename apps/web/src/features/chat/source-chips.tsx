import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { isEntityKind } from "@stll/api-contract";
import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@stll/ui/collapsible";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon } from "@stll/ui/icons";
import { Separator } from "@stll/ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import { chatAppOrigins } from "@/components/chat/chat-app-origins";
import { openEntityInInspector } from "@/components/chat/entity-open";
import { useExternalSourceStore } from "@/components/chat/external-source-store";
import { LegalCitationLink } from "@/components/chat/legal-citation-link";
import type {
  ExternalSourceEntry,
  SourceChipEntry,
} from "@/components/chat/source-chips.logic";
import { collectSourceChipEntries } from "@/components/chat/source-chips.logic";
import { ReferenceIcon } from "@/components/references/reference-chip";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import type { ChatMessage, ChatSourceDocument } from "@/lib/api-contract";
import { detached } from "@/lib/detached";
import { navigateToWorkspaceFolder } from "@/lib/workspaces/reveal-navigation";
import { getCurrentWorkspaceDocument } from "@/lib/workspaces/use-workspace-view-params";

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
  const { entries, uniqueExternalSources } = collectSourceChipEntries({
    appOrigins: chatAppOrigins(),
    parts,
    sourceDocuments,
  });
  const registerSources = useExternalSourceStore(
    (state) => state.registerSources,
  );
  const t = useTranslations("chat.sourceChips");
  const [consultedOpen, setConsultedOpen] = useState(false);
  const cited = entries.filter((entry) => entry.relation === "cited");
  const consulted = entries.filter((entry) => entry.relation === "consulted");

  useExternalSyncEffect(() => {
    registerSources(uniqueExternalSources);
  }, [registerSources, uniqueExternalSources]);

  if (entries.length === 0) {
    return null;
  }

  // Laid out by the answer's footer row: the cited sources and the
  // disclosure's trigger sit in that row after Copy and Retry, wrapping only
  // when they run out of room; the disclosed sources take a full row below.
  return (
    <div className="contents" data-chat-answer-citations>
      {cited.length > 0 && (
        <>
          <Separator
            className="self-stretch"
            data-chat-answer-citations-divider
            orientation="vertical"
          />
          <SourceEntryList
            entries={cited}
            messageId={messageId}
            workspaceId={workspaceId}
          />
        </>
      )}
      {consulted.length > 0 && (
        <Collapsible
          className="contents"
          onOpenChange={setConsultedOpen}
          open={consultedOpen}
        >
          {/* Without cited sources the divider travels with the trigger, so
              it never ends a wrapped line. */}
          <div className="flex items-center gap-2">
            {cited.length === 0 && (
              <Separator
                className="self-stretch"
                data-chat-answer-citations-divider
                orientation="vertical"
              />
            )}
            <CollapsibleTrigger render={<Button size="xs" variant="muted" />}>
              <DirectionalIcon
                className={cn(
                  "size-3.5 shrink-0 transition-transform",
                  consultedOpen && "rotate-90",
                )}
                flip={!consultedOpen}
                icon={ChevronRightIcon}
              />
              {t("alsoConsulted", { count: consulted.length })}
            </CollapsibleTrigger>
          </div>
          <CollapsiblePanel className="w-full">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <SourceEntryList
                entries={consulted}
                messageId={`${messageId}-consulted`}
                workspaceId={workspaceId}
              />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      )}
    </div>
  );
};

const SourceEntryList = ({
  entries,
  messageId,
  workspaceId,
}: {
  entries: SourceChipEntry[];
  messageId: string;
  workspaceId: string | undefined;
}) => {
  const t = useTranslations("caseLaw.courtTiers");
  const caseLaw = entries.filter((entry) => entry.type === "case-law");
  const remaining = entries.filter((entry) => entry.type !== "case-law");
  const tiers = COURT_TIER_LABELS;
  // Flat items for the surrounding flex row: each court tier is a short
  // label followed by its decisions, so the sources stay on the footer line.
  return (
    <>
      {tiers.map((tier) => {
        const rows = caseLaw.filter((entry) => entry.caseLaw.tier === tier);
        if (rows.length === 0) {
          return null;
        }
        return (
          <section className="contents" key={tier}>
            <h4 className="text-muted-foreground shrink-0 text-xs font-medium">
              {t(tier)}
            </h4>
            {rows.map((entry) => (
              <CaseLawSourceRow
                key={`${messageId}-${entry.source.url}`}
                entry={entry}
              />
            ))}
          </section>
        );
      })}
      {remaining.map((entry) =>
        entry.type === "document" ? (
          <SourceChip
            key={`${messageId}-${entry.source.data.entityId}`}
            sourceDocument={entry.source.data}
            workspaceId={workspaceId}
          />
        ) : (
          <PublisherSourceChip
            key={`${messageId}-${entry.source.url}`}
            source={entry.source}
            workspaceId={workspaceId ?? null}
          />
        ),
      )}
    </>
  );
};

const CaseLawSourceRow = ({
  entry,
}: {
  entry: Extract<SourceChipEntry, { type: "case-law" }>;
}) => {
  const format = useFormatter();
  const { caseLaw, source } = entry;
  const date = caseLaw.decisionDate
    ? format.dateTime(new Date(caseLaw.decisionDate), {
        dateStyle: "medium",
        timeZone: "UTC",
      })
    : null;
  // One line, centred on the chip: the holding is hover text, so a long one
  // never makes the chip two rows tall.
  const label = (
    <>
      <span
        aria-label={caseLaw.court}
        className="bg-muted shrink-0 rounded px-1 font-medium"
      >
        {caseLaw.courtShortCode}
      </span>
      <BidiText as="span" className="min-w-0 truncate font-medium">
        {caseLaw.caseNumber}
        {date ? ` · ${date}` : ""}
      </BidiText>
    </>
  );
  const rowClassName = "flex min-w-0 items-center gap-1.5";
  const row = caseLaw.holding ? (
    <Tooltip>
      <TooltipTrigger render={<span className={rowClassName} />}>
        {label}
      </TooltipTrigger>
      <TooltipPopup className="max-w-sm">{caseLaw.holding}</TooltipPopup>
    </Tooltip>
  ) : (
    <span className={rowClassName}>{label}</span>
  );
  return (
    <LegalCitationLink
      appearance="tray"
      fullTrayLabel
      interactive
      linkIconSource={{ kind: "tool-source" }}
      source={source}
    >
      {row}
    </LegalCitationLink>
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
    linkIconSource={{ kind: "tool-source" }}
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
  const router = useRouter();
  const resolvedWorkspaceId =
    workspaceId ?? sourceDocument.workspaceId ?? undefined;

  const handleClick = () => {
    if (!resolvedWorkspaceId) {
      return;
    }

    detached(
      (async () => {
        const result = await openEntityInInspector({
          documentOnScreen: getCurrentWorkspaceDocument(router.state.matches),
          entityId: sourceDocument.entityId,
          label: sourceDocument.title,
          workspaceId: resolvedWorkspaceId,
        });

        if (result.type === "folder") {
          await navigateToWorkspaceFolder({
            folderId: result.entityId,
            navigate,
            router,
            queryClient,
            targetWorkspaceId: result.workspaceId,
          });
        }
      })(),
      "source-chips.open-entity-in-inspector",
    );
  };

  return (
    <Button
      className={cn(
        "group/plain max-w-full min-w-0 shrink-0",
        !resolvedWorkspaceId && "cursor-default",
      )}
      onClick={handleClick}
      variant="plain"
    >
      {/* The chip draws itself: a hairline pill in the answer's own type,
          lit while pointed at when it opens a document. */}
      <span
        className={cn(
          "bg-muted/50 text-foreground inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
          resolvedWorkspaceId && "group-hover/plain:bg-muted",
        )}
      >
        <SourceIcon
          sourceDocument={sourceDocument}
          workspaceId={resolvedWorkspaceId}
        />
        <BidiText as="span" className="max-w-full min-w-0 truncate">
          {sourceDocument.title}
        </BidiText>
      </span>
    </Button>
  );
};
