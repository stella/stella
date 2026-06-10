/**
 * Shared presentational pieces for version-history lists. Both the
 * .docx file Versions facet (inspector) and the template Studio
 * History facet render rows through `VersionRow` so the two panels
 * share one visual language: version number with status chips, the
 * author who saved it, a relative timestamp, an expandable diff
 * against the previous version, and an AI change summary triggered
 * by the wand button. Data fetching stays with the consumers; rows
 * receive async loaders and own only their open/loading state.
 */

import { useState } from "react";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { markerPattern } from "@stll/template-conditions";
import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import { UserAvatar } from "@/components/user-avatar";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";

export const VersionList = ({ children }: React.PropsWithChildren) => (
  <div className="flex flex-col gap-px p-1">{children}</div>
);

export type VersionDiffRun = {
  kind: "same" | "del" | "ins";
  text: string;
};

export type VersionDiffSegment =
  | { kind: "added" | "removed" | "unchanged" | "gap"; text: string }
  | { kind: "changed"; runs: VersionDiffRun[] };

export type VersionRowAuthor = {
  name: string;
  image: string | null;
};

type VersionRowProps = {
  title: string;
  author: VersionRowAuthor | null;
  /** ISO string (entity versions) or Date (Eden-deserialized). */
  createdAt: string | Date;
  isCurrent?: boolean;
  isViewing?: boolean;
  isSelected?: boolean;
  /** Word-level +/− chip; null hides it. */
  stats?: { added: number; removed: number } | null;
  /** Extra muted line under the title (label dot, field count, ...). */
  meta?: React.ReactNode;
  /** Trailing buttons on the action row (download, ...). */
  actions?: React.ReactNode;
  onActivate?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  /** Diff vs the previous version; empty array means no changes. */
  loadDiff?: (() => Promise<VersionDiffSegment[]>) | null;
  /** AI change summary; null means the versions are identical. */
  summarize?: (() => Promise<string | null>) | null;
};

export type AsyncContent<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error" };

export const VersionRow = ({
  title,
  author,
  createdAt,
  isCurrent = false,
  isViewing = false,
  isSelected = false,
  stats,
  meta,
  actions,
  onActivate,
  onContextMenu,
  loadDiff,
  summarize,
}: VersionRowProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const [isDiffOpen, setIsDiffOpen] = useState(false);
  const [diff, setDiff] = useState<AsyncContent<VersionDiffSegment[]>>({
    status: "idle",
  });
  const [summary, setSummary] = useState<AsyncContent<string | null>>({
    status: "idle",
  });

  const toggleDiff = async () => {
    if (!loadDiff) {
      return;
    }
    const nextOpen = !isDiffOpen;
    setIsDiffOpen(nextOpen);
    if (!nextOpen || diff.status === "ready" || diff.status === "loading") {
      return;
    }
    setDiff({ status: "loading" });
    try {
      setDiff({ status: "ready", value: await loadDiff() });
    } catch {
      setDiff({ status: "error" });
    }
  };

  const handleSummarize = async () => {
    if (!summarize || summary.status === "loading") {
      return;
    }
    setSummary({ status: "loading" });
    try {
      setSummary({ status: "ready", value: await summarize() });
    } catch {
      setSummary({ status: "error" });
    }
  };

  const header = (
    <>
      {isSelected && (
        <span
          aria-hidden="true"
          className="bg-primary absolute inset-y-1 start-0 w-0.5 rounded-full"
        />
      )}
      {/* Row 1: version title + status chips + diff stats */}
      <div className="flex w-full items-center gap-1.5">
        <span className="text-sm font-medium">{title}</span>
        {isCurrent && (
          <span className="bg-primary/10 text-primary rounded-full px-1.5 py-0.5 text-[10px] font-medium">
            {t("fileDetail.current")}
          </span>
        )}
        {isViewing && (
          <span className="bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 text-[10px] font-medium">
            {t("fileDetail.viewing")}
          </span>
        )}
        {stats && (
          <span className="ms-auto flex items-center gap-1 text-[10px] tabular-nums">
            <span className="text-success">+{stats.added}</span>
            <span className="text-destructive">−{stats.removed}</span>
          </span>
        )}
      </div>

      {meta}

      {/* Row 2: author + time */}
      <div className="flex items-center gap-1.5">
        {author && (
          <UserAvatar
            className="size-4 shrink-0 text-[8px]"
            image={author.image}
            name={author.name}
          />
        )}
        <span
          className="text-muted-foreground truncate text-xs"
          title={author?.name}
        >
          {author ? firstName(author.name) : ""}
        </span>
        <span
          className="text-muted-foreground shrink-0 text-xs"
          title={formatFullTimestamp(createdAt, locale)}
        >
          {formatRelativeTime(createdAt, locale)}
        </span>
      </div>
    </>
  );

  const headerClassName = cn(
    "relative flex w-full flex-col gap-1.5 rounded-md px-3 py-2 text-start",
    isSelected && "text-accent-foreground",
  );

  let headerElement: React.ReactNode;
  if (onActivate) {
    headerElement = (
      <button
        className={cn(
          headerClassName,
          "transition-colors",
          !isSelected && "hover:bg-muted/50",
        )}
        type="button"
        onClick={onActivate}
        onContextMenu={onContextMenu}
      >
        {header}
      </button>
    );
  } else {
    headerElement = (
      <div className={headerClassName} onContextMenu={onContextMenu}>
        {header}
      </div>
    );
  }

  const hasActionRow =
    Boolean(loadDiff) || Boolean(summarize) || actions !== undefined;

  return (
    <div
      className={cn(
        "rounded-md",
        isSelected && "bg-accent ring-primary/40 ring-1",
      )}
    >
      {headerElement}

      {hasActionRow && (
        <div className="flex items-center gap-0.5 px-2 pb-1.5">
          {loadDiff && (
            <Button
              aria-expanded={isDiffOpen}
              className="text-muted-foreground hover:text-foreground gap-1 px-1.5 text-xs font-normal"
              onClick={() => {
                void toggleDiff();
              }}
              size="xs"
              variant="ghost"
            >
              {isDiffOpen ? (
                <ChevronDownIcon className="size-3" />
              ) : (
                <ChevronRightIcon className="size-3" />
              )}
              {t("fileDetail.showDiff")}
            </Button>
          )}
          {summarize && (
            <Button
              aria-label={t("common.summarizeChanges")}
              className="text-muted-foreground hover:text-foreground"
              disabled={summary.status === "loading"}
              onClick={() => {
                void handleSummarize();
              }}
              size="icon-xs"
              title={t("common.summarizeChanges")}
              variant="ghost"
            >
              {summary.status === "loading" ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <WandSparklesIcon className="size-3.5" />
              )}
            </Button>
          )}
          {actions !== undefined && (
            <span className="ms-auto flex items-center gap-0.5">{actions}</span>
          )}
        </div>
      )}

      {isDiffOpen && (
        <div className="px-2 pb-2">
          <VersionDiffBlock state={diff} />
        </div>
      )}

      <VersionSummaryBlock state={summary} />
    </div>
  );
};

// ── Diff block ───────────────────────────────────────

// Also consumed standalone by the template Clauses tab, which renders
// the same diff/summary visuals for outdated clause links without the
// full VersionRow chrome.
export const VersionDiffBlock = ({
  state,
}: {
  state: AsyncContent<VersionDiffSegment[]>;
}) => {
  const t = useTranslations();

  if (state.status === "idle") {
    return null;
  }
  if (state.status === "loading") {
    return (
      <div className="text-muted-foreground flex items-center gap-1.5 px-1 text-xs">
        <Loader2Icon className="size-3 animate-spin" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <p className="text-muted-foreground px-1 text-xs">
        {t("common.unexpectedError")}
      </p>
    );
  }
  if (state.value.length === 0) {
    return (
      <p className="text-muted-foreground px-1 text-xs">
        {t("clauses.noChanges")}
      </p>
    );
  }
  return (
    <div className="bg-muted/50 flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md px-2.5 py-2 text-xs leading-5 whitespace-pre-wrap">
      {state.value.map((segment, index) => (
        <DiffSegmentParagraph key={index} segment={segment} />
      ))}
    </div>
  );
};

// Track-changes styling, matched to folio's suggestion preview
// (.folio-ai-suggestion--focused-original/-replacement): deletions
// read as dimmed muted strikethrough with a faint destructive tint,
// insertions as a low-saturation success wash with an inset ring.
// color-mix over semantic tokens keeps both theme-aware without
// importing folio's stylesheet.
const DEL_STYLE: React.CSSProperties = {
  color: "color-mix(in oklch, var(--destructive) 35%, var(--muted-foreground))",
  textDecorationLine: "line-through",
  textDecorationThickness: "1px",
  textDecorationColor:
    "color-mix(in oklch, var(--destructive) 30%, var(--muted-foreground))",
};

const INS_STYLE: React.CSSProperties = {
  borderRadius: "3px",
  padding: "0 2px",
  backgroundColor: "color-mix(in oklch, var(--success) 14%, transparent)",
  boxShadow:
    "inset 0 0 0 1px color-mix(in oklch, var(--success) 28%, transparent)",
  textDecorationLine: "none",
  boxDecorationBreak: "clone",
  WebkitBoxDecorationBreak: "clone",
};

const DiffSegmentParagraph = ({ segment }: { segment: VersionDiffSegment }) => {
  if (segment.kind === "gap") {
    // The API elides long unchanged runs server-side and sends only the
    // context lines, so this stays a quiet marker, not an expander.
    return (
      <div
        aria-hidden="true"
        className="text-foreground-placeholder text-center text-[10px] leading-3 tracking-[0.25em] select-none"
      >
        ···
      </div>
    );
  }
  if (segment.kind === "changed") {
    return (
      <p>
        {segment.runs.map((run, index) => (
          <DiffRunSpan key={index} run={run} />
        ))}
      </p>
    );
  }
  if (segment.kind === "added") {
    return (
      <ins style={INS_STYLE}>
        <MarkerAwareText text={segment.text} />
      </ins>
    );
  }
  if (segment.kind === "removed") {
    return (
      <del style={DEL_STYLE}>
        <MarkerAwareText text={segment.text} />
      </del>
    );
  }
  return (
    <p className="text-muted-foreground">
      <MarkerAwareText text={segment.text} />
    </p>
  );
};

const DiffRunSpan = ({ run }: { run: VersionDiffRun }) => {
  if (run.kind === "del") {
    return (
      <del style={DEL_STYLE}>
        <MarkerAwareText text={run.text} />
      </del>
    );
  }
  if (run.kind === "ins") {
    return (
      <ins style={INS_STYLE}>
        <MarkerAwareText text={run.text} />
      </ins>
    );
  }
  return <MarkerAwareText text={run.text} />;
};

/** Renders text in the reading font, with `{{...}}` template markers
 *  set off as inline mono code spans. */
const MarkerAwareText = ({ text }: { text: string }) => {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(markerPattern())) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    nodes.push(
      <code className="font-mono text-[11px]" key={match.index}>
        {match[0]}
      </code>,
    );
    cursor = match.index + match[0].length;
  }
  if (nodes.length === 0) {
    return text;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
};

// ── AI summary block ─────────────────────────────────

export const VersionSummaryBlock = ({
  state,
}: {
  state: AsyncContent<string | null>;
}) => {
  const t = useTranslations();

  if (state.status === "idle" || state.status === "loading") {
    return null;
  }
  if (state.status === "error") {
    return (
      <p className="text-muted-foreground px-3 pb-2 text-xs">
        {t("search.summaryError")}
      </p>
    );
  }
  if (state.value === null) {
    return (
      <p className="text-muted-foreground px-3 pb-2 text-xs">
        {t("clauses.noChanges")}
      </p>
    );
  }
  return (
    <p className="bg-muted/50 text-muted-foreground mx-2 mb-2 rounded-md p-2 text-xs">
      {state.value}
    </p>
  );
};

// ── Utilities ────────────────────────────────────────

const firstName = (fullName: string) =>
  fullName.split(/\s+/u).at(0) ?? fullName;
