import type { ReactNode } from "react";

import type { UseMutationResult } from "@tanstack/react-query";
import {
  FileTextIcon,
  HistoryIcon,
  LandmarkIcon,
  LoaderIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  UserIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { CommandItem } from "@stll/ui/command";

import { DocumentIcon } from "@/components/document-icon";
import { MatterIcon } from "@/components/matter-icon";
import {
  compactMeta,
  KIND_TRANSLATION_KEYS,
} from "@/components/search-dialog.shared";
import Tooltip from "@/components/tooltip";
import { UserIdentity } from "@/components/user-avatar";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import type { ResolvedCommandAction } from "@/features/command-palette/hooks/use-command-actions";
import { useHydrationSafeHotkeyPlatform } from "@/hooks/use-hydration-safe-hotkey-platform";
import { useFormatter } from "@/i18n/formatting-context";
import type { api } from "@/lib/api";
import type { GlobalSearchHit } from "@/lib/api-contract";
import { formatHotkeyForPlatform } from "@/lib/hotkeys";
import type { SearchAISummaryParams } from "@/lib/search";
import type { RecentFile, RecentSearch } from "@/lib/search-recents";

type SearchSummaryData = NonNullable<
  Awaited<ReturnType<typeof api.search.summary.post>>["data"]
>;

type SearchSummaryItemProps = {
  summarizeMutation: UseMutationResult<
    SearchSummaryData,
    Error,
    SearchAISummaryParams
  >;
  isOpeningChat: boolean;
  onClick: () => void;
  onOpenChat: () => void;
  onCitationClick: (citationId: string) => void;
};

export type CommandActionEntry = {
  type: "command-action";
  title: string;
  action: ResolvedCommandAction;
};

type CommandActionItemProps = {
  entry: CommandActionEntry;
  navigation: { type: "button" } | { type: "command"; index: number };
  onSelect: (actionId: string) => void;
};

export const CommandActionItem = ({
  entry,
  navigation,
  onSelect,
}: CommandActionItemProps) => {
  const { action } = entry;
  const Icon = action.icon;
  const hotkeyPlatform = useHydrationSafeHotkeyPlatform();
  const content = (
    <>
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{action.title}</span>
      {action.hotkey && (
        <kbd className="bg-muted text-muted-foreground pointer-events-none inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] font-medium select-none">
          {formatHotkeyForPlatform(action.hotkey, hotkeyPlatform)}
        </kbd>
      )}
    </>
  );
  switch (navigation.type) {
    case "command":
      return (
        <CommandItem
          className="min-h-11 w-full gap-2 px-2 py-2 text-start text-sm"
          data-command-action-id={action.id}
          data-command-action-index={navigation.index}
          index={navigation.index}
          onClick={() => onSelect(action.id)}
          value={entry}
        >
          {content}
        </CommandItem>
      );
    case "button":
      return (
        <Button
          className="h-auto min-h-11 w-full justify-start gap-2 px-2 py-2 text-start text-sm"
          data-command-action-id={action.id}
          data-search-empty-row=""
          onClick={() => onSelect(action.id)}
          variant="ghost"
        >
          {content}
        </Button>
      );
    default: {
      const exhaustive: never = navigation;
      return exhaustive;
    }
  }
};

export const SearchSummaryItem = ({
  isOpeningChat,
  summarizeMutation,
  onClick,
  onOpenChat,
  onCitationClick,
}: SearchSummaryItemProps) => {
  const t = useTranslations();
  const { isPending, isError, isSuccess, data } = summarizeMutation;

  if (!isSuccess) {
    let title = t("search.summaryAction");
    let body = t("search.summaryPrompt");
    if (isPending) {
      title = t("search.summaryLoading");
    } else if (isError) {
      title = t("search.summaryError");
      body = t("search.summaryRetry");
    }

    return (
      <Button
        className="mb-2 h-auto w-full items-start justify-start gap-3 rounded-md px-2.5 py-2.5 text-start whitespace-normal sm:h-auto"
        disabled={isPending}
        onClick={onClick}
        variant={isError ? "destructive-outline" : "outline"}
      >
        <span className="bg-background text-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border">
          {isPending ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <WandSparklesIcon className="size-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="text-muted-foreground line-clamp-2 text-xs font-normal">
            {body}
          </span>
        </span>
      </Button>
    );
  }

  return (
    <div className="border-border bg-background mb-2 w-full rounded-md border px-2.5 py-2.5 text-start shadow-xs">
      <div className="flex w-full items-start gap-3 text-start">
        <span className="bg-background text-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border">
          <WandSparklesIcon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {data.title}
          </span>
          <span className="text-muted-foreground block text-xs font-normal whitespace-pre-line">
            <SummaryBody
              citations={data.citations}
              onCitationClick={onCitationClick}
              text={data.summary}
            />
          </span>
        </span>
      </div>
      <div className="border-border/70 mt-2 border-t pt-2">
        <Button
          className="h-auto gap-2 px-1.5 py-1 text-xs"
          disabled={isOpeningChat}
          onClick={onOpenChat}
          size="sm"
          variant="ghost"
        >
          {isOpeningChat ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <MessageSquareIcon className="size-3.5" />
          )}
          {t("search.continueInChat")}
        </Button>
      </div>
    </div>
  );
};

type SummaryBodyProps = {
  text: string;
  citations: SearchSummaryData["citations"];
  onCitationClick: (citationId: string) => void;
};

const CITATION_RE = /\[(?<number>\d+)\]/gu;

const SummaryBody = ({
  citations,
  onCitationClick,
  text,
}: SummaryBodyProps) => {
  const citationByNumber = new Map(
    citations.map((citation) => [citation.number, citation]),
  );
  const parts: ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(CITATION_RE)) {
    const start = match.index;
    const numberText = match.groups?.["number"];
    const number = numberText ? Number(numberText) : Number.NaN;
    const citation = citationByNumber.get(number);
    if (start > cursor) {
      parts.push(text.slice(cursor, start));
    }
    if (citation) {
      parts.push(
        <Tooltip
          content={`${citation.title}\n${citation.reason}`}
          key={`${citation.id}-${start}`}
          layer="search-child"
          render={
            <button
              className="text-foreground hover:bg-muted mx-0.5 rounded px-1 font-medium"
              onClick={(event) => {
                event.stopPropagation();
                onCitationClick(citation.id);
              }}
              type="button"
            >
              [{citation.number}]
            </button>
          }
        />,
      );
    } else {
      parts.push(match[0]);
    }
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
};

type SearchRecentsProps = {
  recentSearches: RecentSearch[];
  recentFiles: RecentFile[];
  onSearchClick: (recent: RecentSearch) => void;
  onFileClick: (file: RecentFile) => void;
  onFilePreview: (file: RecentFile) => void;
  previewedFileId: string | null;
};

export const SearchRecents = ({
  recentSearches,
  recentFiles,
  onSearchClick,
  onFileClick,
  onFilePreview,
  previewedFileId,
}: SearchRecentsProps) => {
  const t = useTranslations();
  const hasRecents = recentSearches.length > 0 || recentFiles.length > 0;
  if (!hasRecents) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-8">
        <p className="text-muted-foreground text-sm">
          {t("search.emptyState")}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-5 px-4 py-4">
      {recentSearches.length > 0 && (
        <section>
          <h3 className="text-muted-foreground mb-2 text-xs font-medium">
            {t("search.recentSearches")}
          </h3>
          <div className="space-y-1">
            {recentSearches.map((recent) => (
              <Button
                className="h-auto w-full justify-start gap-2 px-2 py-2 text-start text-sm"
                data-search-empty-row=""
                key={recent.query}
                onClick={() => onSearchClick(recent)}
                variant="ghost"
              >
                <HistoryIcon className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate">{recent.query}</span>
              </Button>
            ))}
          </div>
        </section>
      )}
      {recentFiles.length > 0 && (
        <section>
          <h3 className="text-muted-foreground mb-2 text-xs font-medium">
            {t("search.recentlyOpenedFiles")}
          </h3>
          <div className="flex flex-col gap-y-1">
            {recentFiles.map((file) => (
              <Button
                aria-current={
                  previewedFileId === file.entityId ? "true" : undefined
                }
                className="h-auto! w-full justify-start gap-2 py-1 text-start text-sm"
                data-previewing={previewedFileId === file.entityId}
                data-search-empty-row=""
                key={file.entityId}
                onFocus={() => onFilePreview(file)}
                onClick={() => {
                  onFileClick(file);
                }}
                onPointerEnter={() => onFilePreview(file)}
                variant={
                  previewedFileId === file.entityId ? "secondary" : "ghost"
                }
              >
                {file.mimeType ? (
                  <DocumentIcon
                    className="text-muted-foreground size-4 shrink-0"
                    mimeType={file.mimeType}
                  />
                ) : (
                  <FileTextIcon className="text-muted-foreground size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <BidiText as="span" className="block truncate">
                    {file.title}
                  </BidiText>
                  <BidiText
                    as="span"
                    className="text-muted-foreground block truncate text-xs"
                  >
                    {file.workspaceName}
                  </BidiText>
                </span>
              </Button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

type SearchResultItemProps = {
  hit: GlobalSearchHit;
  index: number;
  resultNumber: number;
  onClick: (
    hit: GlobalSearchHit,
    options?: { locationModifier?: boolean },
  ) => void;
};

export const SearchResultItem = ({
  hit,
  index,
  resultNumber,
  onClick,
}: SearchResultItemProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const formatted = format.dateTime(new Date(hit.updatedAt), {
    month: "short",
    year: "numeric",
  });
  let editorMeta: { image: string | null; name: string } | null = null;
  if (hit.type === "document" && hit.lastEditedByName) {
    editorMeta = {
      image: hit.lastEditedByImage,
      name: hit.lastEditedByName,
    };
  }
  let meta: string;
  if (hit.type === "contact") {
    meta = t(KIND_TRANSLATION_KEYS[hit.type]);
  } else if (hit.type === "case-law") {
    meta = "";
  } else if (hit.type === "matter" || hit.type === "chat") {
    meta = compactMeta([hit.workspaceName, formatted]);
  } else {
    meta = compactMeta([
      hit.workspaceName,
      formatted,
      hit.type === "document" ? null : hit.lastEditedByName,
    ]);
  }
  return (
    <CommandItem
      className="h-auto w-full items-start justify-start gap-3 px-2 py-2 text-start whitespace-normal sm:h-auto"
      index={index}
      onClick={(event) =>
        onClick(hit, { locationModifier: event.metaKey || event.ctrlKey })
      }
      value={hit}
    >
      <SearchHitIcon hit={hit} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{hit.title || hit.id}</p>
        {(meta || editorMeta) && (
          <div className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
            {meta ? <span className="min-w-0 truncate">{meta}</span> : null}
            {editorMeta ? (
              <>
                {meta ? <span className="shrink-0">·</span> : null}
                <UserIdentity
                  as="span"
                  avatarClassName="size-4 shrink-0 text-[0.5rem]"
                  avatarFallbackClassName="text-[0.5rem]"
                  className="gap-1.5"
                  image={editorMeta.image}
                  name={editorMeta.name}
                  nameClassName="text-xs font-normal"
                />
              </>
            ) : null}
          </div>
        )}
        {hit.headline && (
          <p
            className="text-muted-foreground [&_mark]:bg-highlight [&_mark]:text-highlight-foreground mt-0.5 line-clamp-2 text-xs font-normal [&_mark]:font-medium"
            dangerouslySetInnerHTML={{
              // safe-html: server-escaped + <mark>-highlighted by escapeAndHighlight() in the global search mappers
              __html: hit.headline,
            }}
          />
        )}
      </div>
      <span className="text-foreground-subtle mt-0.5 shrink-0 px-1 text-xs tabular-nums">
        {resultNumber}
      </span>
    </CommandItem>
  );
};

const NON_ENTITY_KIND_ICONS = {
  contact: UserIcon,
  "case-law": LandmarkIcon,
  chat: MessagesSquareIcon,
} as const;

export const SearchHitIcon = ({ hit }: { hit: GlobalSearchHit }) => {
  switch (hit.type) {
    case "document":
    case "folder":
    case "task":
    case "message":
    case "link":
      return (
        <EntityKindIcon
          className="text-muted-foreground mt-0.5 size-4 shrink-0"
          kind={hit.type}
          mimeType={hit.mimeType}
        />
      );
    case "matter":
      return (
        <MatterIcon
          className="mt-0.5 size-4 shrink-0"
          matter={{ id: hit.workspaceId, color: hit.color }}
        />
      );
    case "contact":
    case "case-law":
    case "chat": {
      const Icon = NON_ENTITY_KIND_ICONS[hit.type];
      return <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />;
    }
    default: {
      const exhaustive: never = hit;
      return exhaustive;
    }
  }
};
