import { useState } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { AiDisclosureContext } from "@stll/api-contract/ai-disclosure";
import { ReaderAiLabel } from "@stll/decision-reader/reader-ai-label";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon } from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import {
  compactReaderPath,
  fitReaderPath,
  readerProvisionNumber,
} from "./reader-breadcrumb.logic";
import type { ReaderContentsRow, ReaderTrail } from "./reader-contents.logic";

/**
 * How the trail's hidden middle is open. A hover only shows its sections; a
 * press or the keyboard opens it to work in, and only then does focus move
 * into it: a focused entry shows its tooltip over the trail the pointer is
 * crossing, which would cover the section the reader is heading for.
 */
const MIDDLE_STATE = {
  closed: "closed",
  hovered: "hovered",
  opened: "opened",
} as const;
type MiddleState = (typeof MIDDLE_STATE)[keyof typeof MIDDLE_STATE];

/** A press keeps the middle open; any other change follows `open`. */
const middleAfterChange = (open: boolean, reason: string): MiddleState =>
  reason === "trigger-press" || open
    ? MIDDLE_STATE.opened
    : MIDDLE_STATE.closed;

/** A hover shows a closed middle and leaves an open one as it is. */
const middleAfterHover = (state: MiddleState): MiddleState =>
  state === MIDDLE_STATE.closed ? MIDDLE_STATE.hovered : state;

type ReaderBreadcrumbProps = {
  trail: ReaderTrail;
  rows: readonly ReaderContentsRow[];
  /** The row being read, which Contents marks as the current location. */
  activeAnchorId: string | null;
  onJump: (anchorId: string) => void;
};

// A stable callback ref: it runs when Contents opens, never again while it
// stays open, so rows arriving later cannot move the list under the reader.
const revealCurrentRow = (node: HTMLDivElement | null) => {
  node
    ?.querySelector<HTMLElement>("[data-contents-anchor][aria-current]")
    ?.scrollIntoView({ block: "nearest" });
};

type ReaderContentsListProps = {
  rows: readonly ReaderContentsRow[];
  activeAnchorId: string | null;
  onSelect: (anchorId: string) => void;
};

const ReaderContentsList = ({
  rows,
  activeAnchorId,
  onSelect,
}: ReaderContentsListProps) => {
  const t = useTranslations();
  const jump = ({
    anchorId,
    label,
    children,
    className,
  }: {
    anchorId: string;
    label?: string;
    children: ReactNode;
    className?: string;
  }) => (
    <Button
      layout="wrap"
      aria-current={anchorId === activeAnchorId ? "location" : undefined}
      aria-label={label}
      className={cn("min-w-0 flex-1", className)}
      data-contents-anchor={anchorId}
      onClick={() => onSelect(anchorId)}
      // The row shows its title; a tooltip of its accessible name would open
      // on the focus the list takes and swallow the Escape that closes it.
      tooltip={false}
      variant="ghost"
    >
      {children}
    </Button>
  );
  const aiLabel = (disclosure: AiDisclosureContext) => (
    <span className="text-muted-foreground shrink-0 pe-2 text-xs">
      <ReaderAiLabel context={disclosure} label={t("caseLaw.notesFilter.ai")} />
    </span>
  );
  const row = (entry: ReaderContentsRow) => {
    switch (entry.type) {
      case "heading": {
        return jump({
          anchorId: entry.anchorId,
          children: <bdi>{entry.title}</bdi>,
        });
      }
      case "analysis": {
        return (
          <>
            {jump({
              anchorId: entry.anchorId,
              label: t("legalReader.contents.aiSection", {
                section: entry.title,
              }),
              children: <bdi>{entry.title}</bdi>,
              className: "text-muted-foreground",
            })}
            {aiLabel(entry.disclosure)}
          </>
        );
      }
      case "headingWithAnalysis": {
        return (
          <>
            {jump({
              anchorId: entry.anchorId,
              label: t("legalReader.contents.headingWithAiSection", {
                heading: entry.title,
                section: entry.analysisTitle,
              }),
              children: (
                <span className="flex min-w-0 flex-col items-start gap-0.5 py-1">
                  <bdi>{entry.title}</bdi>
                  <bdi className="text-muted-foreground text-xs">
                    {entry.analysisTitle}
                  </bdi>
                </span>
              ),
            })}
            {aiLabel(entry.disclosure)}
          </>
        );
      }
      default: {
        entry satisfies never;
        return panic("Unhandled contents row");
      }
    }
  };
  return (
    <ScrollArea
      axis="vertical"
      className="max-h-72"
      viewportRef={revealCurrentRow}
    >
      <ol>
        {rows.map((entry) => (
          // The AI mark is a control of its own, so it sits beside the jump
          // rather than inside it.
          <li className="flex items-center gap-1" key={entry.anchorId}>
            {row(entry)}
          </li>
        ))}
      </ol>
    </ScrollArea>
  );
};

export const ReaderBreadcrumb = ({
  trail,
  rows,
  activeAnchorId,
  onJump,
}: ReaderBreadcrumbProps) => {
  const t = useTranslations();
  const path = trail.segments;
  // A model's titles are named as AI-generated wherever the trail shows them.
  const nameOf = (title: string) => {
    switch (trail.type) {
      case "document":
        return title;
      case "analysis":
        return t("legalReader.contents.aiSection", { section: title });
      default:
        trail satisfies never;
        return panic("Unhandled reader trail");
    }
  };
  const { visible, hidden } = compactReaderPath(path);
  const [layout, setLayout] = useState<ReturnType<typeof fitReaderPath>>();
  const [contentsOpen, setContentsOpen] = useState(false);
  const [middle, setMiddle] = useState<MiddleState>(MIDDLE_STATE.closed);
  const current = path.at(-1);
  const currentNumber = readerProvisionNumber(current?.title ?? "");
  const currentWidth =
    current === undefined ? undefined : layout?.widths.at(-1);
  const measure = (node: HTMLElement | null) => {
    if (node === null) {
      return undefined;
    }
    const update = () => {
      if (node.clientWidth === 0) {
        return;
      }
      const labels = compactReaderPath(path).visible.flatMap(({ anchorId }) => {
        const label = node.querySelector<HTMLElement>(
          `[data-breadcrumb-measure="${CSS.escape(anchorId)}"]`,
        );
        return label === null ? [] : [label];
      });
      const number = node.querySelector<HTMLElement>(
        "[data-breadcrumb-number-measure]",
      );
      const naturalWidths = labels.map(
        (label) => label.getBoundingClientRect().width + 16,
      );
      const minimumWidths = labels.map((_, index) =>
        index === labels.length - 1
          ? Math.max(44, (number?.getBoundingClientRect().width ?? 0) + 16)
          : 16,
      );
      // The AI mark beside an analysis trail keeps its own width.
      const mark = node.querySelector<HTMLElement>("[data-breadcrumb-ai-mark]");
      const fitted = fitReaderPath({
        available:
          node.clientWidth - (mark?.getBoundingClientRect().width ?? 0),
        separatorWidth: 16,
        middleWidth: hidden.length === 0 ? 0 : 60,
        naturalWidths,
        minimumWidths,
      });
      setLayout((previous) =>
        previous?.showMiddle === fitted.showMiddle &&
        previous.widths.length === fitted.widths.length &&
        previous.widths.every((width, index) => width === fitted.widths[index])
          ? previous
          : fitted,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const label of node.querySelectorAll<HTMLElement>(
      "[data-breadcrumb-measure]",
    )) {
      observer.observe(label);
    }
    update();
    return () => observer.disconnect();
  };
  const hiddenEntries = (close: () => void) => (
    <ol>
      {hidden.map(({ anchorId, title }) => (
        <li key={anchorId}>
          <Button
            layout="wrap"
            aria-label={nameOf(title)}
            className="w-full"
            // As in Contents: the row shows its title, and a tooltip would
            // take the list's Escape.
            tooltip={false}
            onClick={() => {
              onJump(anchorId);
              close();
            }}
            variant="ghost"
          >
            <bdi>{title}</bdi>
          </Button>
        </li>
      ))}
    </ol>
  );
  const contentsControl = ({
    label,
    title,
    width,
  }: {
    label: ReactNode;
    title?: string;
    width?: number;
  }) => (
    <Popover open={contentsOpen} onOpenChange={setContentsOpen}>
      <PopoverTrigger
        aria-label={
          title === undefined
            ? t("statutes.outline")
            : `${t("statutes.outline")}: ${nameOf(title)}`
        }
        render={
          <Button
            className="h-11 min-w-0 sm:h-11"
            size="xs"
            style={{ width }}
            variant="ghost"
          />
        }
        title={title}
      >
        {label}
      </PopoverTrigger>
      {/* Opens toward the inline end, over the text the bar belongs to, not
          back over a notes column at the reader's inline start. */}
      <PopoverPopup
        align="start"
        aria-label={t("statutes.outline")}
        className="w-80 max-w-[calc(100vw-2rem)]"
        padding="sm"
      >
        <ReaderContentsList
          activeAnchorId={activeAnchorId}
          onSelect={(anchorId) => {
            onJump(anchorId);
            setContentsOpen(false);
          }}
          rows={rows}
        />
      </PopoverPopup>
    </Popover>
  );
  return (
    <nav
      aria-label={t("statutes.outline")}
      className="relative min-w-0 flex-1 overflow-hidden"
      data-slot="reader-breadcrumb"
      ref={measure}
    >
      <span aria-atomic="true" aria-live="polite" className="sr-only">
        {path.map(({ title }) => nameOf(title)).join(" › ")}
      </span>
      <div
        aria-hidden="true"
        className="pointer-events-none invisible absolute flex w-max text-sm whitespace-nowrap sm:text-xs"
      >
        {visible.map(({ anchorId, title }) => (
          <span data-breadcrumb-measure={anchorId} key={anchorId}>
            {title}
          </span>
        ))}
        <span data-breadcrumb-number-measure>
          {readerProvisionNumber(current?.title ?? "")}
        </span>
      </div>
      <ol className="flex h-11 min-w-0 items-center">
        {visible.slice(0, -1).map((segment, index) => {
          if (layout?.widths[index] === 0) {
            return null;
          }
          return (
            <li
              className="flex min-w-0 shrink-0 items-center"
              key={segment.anchorId}
            >
              {index > 0 &&
                visible
                  .slice(0, index)
                  .some(
                    (_, previousIndex) => layout?.widths[previousIndex] !== 0,
                  ) && (
                  <DirectionalIcon
                    aria-hidden="true"
                    className="size-4 shrink-0"
                    icon={ChevronRightIcon}
                  />
                )}
              <Button
                aria-label={nameOf(segment.title)}
                className="h-11 min-w-0 sm:h-11"
                size="xs"
                onClick={() => onJump(segment.anchorId)}
                style={{ width: layout?.widths[index] }}
                title={segment.title}
                variant="ghost"
              >
                <bdi className="truncate">{segment.title}</bdi>
              </Button>
              {index === 0 &&
                hidden.length > 0 &&
                (layout?.showMiddle ?? true) && (
                  <>
                    <DirectionalIcon
                      aria-hidden="true"
                      className="size-4 shrink-0"
                      icon={ChevronRightIcon}
                    />
                    <Popover
                      open={middle !== MIDDLE_STATE.closed}
                      onOpenChange={(open, { reason }) =>
                        setMiddle(middleAfterChange(open, reason))
                      }
                    >
                      <PopoverTrigger
                        aria-label={t("common.showMore")}
                        onMouseEnter={() => setMiddle(middleAfterHover)}
                        render={
                          <Button
                            className="size-11 shrink-0"
                            tooltip={t("common.showMore")}
                            variant="ghost"
                          />
                        }
                      >
                        …
                      </PopoverTrigger>
                      <PopoverPopup
                        align="start"
                        aria-label={t("common.showMore")}
                        className="w-80 max-w-[calc(100vw-2rem)]"
                        initialFocus={middle !== MIDDLE_STATE.hovered}
                        padding="sm"
                      >
                        <ScrollArea axis="vertical" className="max-h-72">
                          {hiddenEntries(() => setMiddle(MIDDLE_STATE.closed))}
                        </ScrollArea>
                      </PopoverPopup>
                    </Popover>
                  </>
                )}
            </li>
          );
        })}
        {(current !== undefined || rows.length > 0) && (
          // Keep the Contents root and trigger mounted as scrolling changes
          // the path; Base UI associates an open popup with its trigger id.
          <li className="flex min-w-0 shrink-0 items-center">
            {visible
              .slice(0, -1)
              .some((_, index) => layout?.widths[index] !== 0) && (
              <DirectionalIcon
                aria-hidden="true"
                className="size-4 shrink-0"
                icon={ChevronRightIcon}
              />
            )}
            {contentsControl({
              label:
                current === undefined ? (
                  t("statutes.outline")
                ) : (
                  <span className="flex min-w-0 items-center">
                    <bdi
                      className={cn(
                        currentNumber === null ? "truncate" : "shrink-0",
                      )}
                    >
                      {currentNumber ?? current.title}
                    </bdi>
                    {currentNumber !== null && (
                      <bdi className="ms-1 truncate">
                        {current.title.replace(currentNumber, "").trim()}
                      </bdi>
                    )}
                  </span>
                ),
              ...(current === undefined ? {} : { title: current.title }),
              ...(currentWidth === undefined ? {} : { width: currentWidth }),
            })}
            {trail.type === "analysis" && current !== undefined && (
              // A control of its own, so it sits beside the trigger.
              <span
                className="text-muted-foreground shrink-0 px-1 text-xs"
                data-breadcrumb-ai-mark=""
              >
                <ReaderAiLabel
                  context={trail.disclosure}
                  label={t("caseLaw.notesFilter.ai")}
                />
              </span>
            )}
          </li>
        )}
      </ol>
    </nav>
  );
};
