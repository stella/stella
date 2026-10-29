import { Fragment, useState } from "react";
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
  fitWidth,
  splitReaderHeading,
} from "./reader-breadcrumb.logic";
import type {
  ReaderBreadcrumbSegment,
  ReaderHeadingParts,
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
      aria-current={anchorId === activeAnchorId ? "location" : undefined}
      aria-label={label}
      className={cn(
        "min-h-11 min-w-0 flex-1 justify-start text-start whitespace-normal",
        className,
      )}
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

/** A crumb's button padding and border, which its measured text leaves out. */
const CRUMB_PADDING_WIDTH = 16;
const SEPARATOR_WIDTH = 16;
const MENU_WIDTH = 44;
/** Under about a dozen characters a title says nothing worth its width. */
const MINIMUM_TITLE_WIDTH = 80;
const MAXIMUM_ANCESTOR_LABEL_WIDTH = 160;

/**
 * A crumb's text: its label, which is cut only when it stands alone, then its
 * title, which gives way first.
 */
const CrumbText = ({
  parts,
  withTitle,
}: {
  parts: ReaderHeadingParts;
  withTitle: boolean;
}) => {
  const title = withTitle ? parts.title : null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <bdi className={cn(title === null ? "min-w-0 truncate" : "shrink-0")}>
        {parts.label}
      </bdi>
      {title !== null && (
        <bdi className="min-w-0 truncate font-normal">{title}</bdi>
      )}
    </span>
  );
};

type TrailMenuProps = {
  /** Every outer level not on the bar, in document order. */
  entries: readonly ReaderBreadcrumbSegment[];
  nameOf: (title: string) => string;
  onJump: (anchorId: string) => void;
};

/** The "…" that lists the levels the bar leaves out. */
const TrailMenu = ({ entries, nameOf, onJump }: TrailMenuProps) => {
  const t = useTranslations();
  const [middle, setMiddle] = useState<MiddleState>(MIDDLE_STATE.closed);

  return (
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
          <ol>
            {entries.map(({ anchorId, title }) => (
              <li key={anchorId}>
                <Button
                  aria-label={nameOf(title)}
                  className="min-h-11 w-full justify-start text-start whitespace-normal"
                  // As in Contents: the row shows its title, and a tooltip
                  // would take the list's Escape.
                  tooltip={false}
                  onClick={() => {
                    onJump(anchorId);
                    setMiddle(MIDDLE_STATE.closed);
                  }}
                  variant="ghost"
                >
                  <bdi>{title}</bdi>
                </Button>
              </li>
            ))}
          </ol>
        </ScrollArea>
      </PopoverPopup>
    </Popover>
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
  const current = path.at(-1);
  const ancestors = visible.slice(0, -1);
  const fitOf = (index: number) => layout?.fits[index];
  const widthOf = (index: number) => {
    const fit = fitOf(index);
    return fit === undefined || fit.type === "folded" ? undefined : fit.width;
  };
  const measure = (node: HTMLElement | null) => {
    if (node === null) {
      return undefined;
    }
    const update = () => {
      if (node.clientWidth === 0) {
        return;
      }
      const widthOfMeasure = (part: "label" | "full", anchorId: string) =>
        (node
          .querySelector<HTMLElement>(
            `[data-breadcrumb-${part}="${CSS.escape(anchorId)}"]`,
          )
          ?.getBoundingClientRect().width ?? 0) + CRUMB_PADDING_WIDTH;
      const crumbs = compactReaderPath(path).visible.map(({ anchorId }) => ({
        label: widthOfMeasure("label", anchorId),
        full: widthOfMeasure("full", anchorId),
      }));
      // The AI mark beside an analysis trail keeps its own width.
      const mark = node.querySelector<HTMLElement>("[data-breadcrumb-ai-mark]");
      const fitted = fitReaderPath({
        available:
          node.clientWidth - (mark?.getBoundingClientRect().width ?? 0),
        crumbs,
        hiddenCount: compactReaderPath(path).hidden.length,
        separatorWidth: SEPARATOR_WIDTH,
        menuWidth: MENU_WIDTH,
        minimumTitleWidth: MINIMUM_TITLE_WIDTH,
        maximumAncestorLabelWidth: MAXIMUM_ANCESTOR_LABEL_WIDTH,
      });
      setLayout((previous) =>
        previous?.showMenu === fitted.showMenu &&
        previous.fits.length === fitted.fits.length &&
        previous.fits.every(
          (fit, index) =>
            fit.type === fitted.fits[index]?.type &&
            fitWidth(fit) === fitWidth(fitted.fits[index]),
        )
          ? previous
          : fitted,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const label of node.querySelectorAll<HTMLElement>(
      "[data-breadcrumb-label], [data-breadcrumb-full]",
    )) {
      observer.observe(label);
    }
    update();
    return () => observer.disconnect();
  };
  // Every outer level not on the bar, in document order: the middle levels
  // the trail always keeps off it, and any it folded for want of width.
  const offBar = path
    .slice(0, -1)
    .filter(
      ({ anchorId }) =>
        hidden.some((segment) => segment.anchorId === anchorId) ||
        ancestors.some(
          (segment, index) =>
            segment.anchorId === anchorId && fitOf(index)?.type === "folded",
        ),
    );
  const showMenu = layout?.showMenu ?? hidden.length > 0;
  const contentsControl = ({
    label,
    title,
    width,
  }: {
    label: ReactNode;
    title?: string;
    width?: number | undefined;
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
            className="h-11 min-w-0 justify-start sm:h-11"
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
  // The bar's items in order. Folding takes outer levels outermost first, so
  // the menu stands where the levels it lists would: after the outermost
  // level while that one is shown, at the start once it is folded too.
  const shownAncestors = ancestors.flatMap((segment, index) =>
    fitOf(index)?.type === "folded" ? [] : [{ segment, index }],
  );
  const menuAt = fitOf(0)?.type === "folded" ? 0 : 1;
  const items: (
    | { type: "ancestor"; segment: ReaderBreadcrumbSegment; index: number }
    | { type: "menu" }
  )[] = shownAncestors.map(({ segment, index }) => ({
    type: "ancestor",
    segment,
    index,
  }));
  if (showMenu) {
    items.splice(Math.min(menuAt, items.length), 0, { type: "menu" });
  }
  const separator = (
    <DirectionalIcon
      aria-hidden="true"
      className="size-4 shrink-0"
      icon={ChevronRightIcon}
    />
  );
  const currentFit = fitOf(visible.length - 1);
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
        className="pointer-events-none invisible absolute flex w-max text-sm font-medium whitespace-nowrap sm:text-xs"
      >
        {visible.map(({ anchorId, title }) => {
          const parts = splitReaderHeading(title);
          return (
            <Fragment key={anchorId}>
              <span data-breadcrumb-label={anchorId}>
                <CrumbText parts={parts} withTitle={false} />
              </span>
              <span data-breadcrumb-full={anchorId}>
                <CrumbText parts={parts} withTitle />
              </span>
            </Fragment>
          );
        })}
      </div>
      <ol className="flex h-11 min-w-0 items-center">
        {items.map((item, position) => (
          <li
            className="flex min-w-0 shrink-0 items-center"
            key={item.type === "menu" ? "menu" : item.segment.anchorId}
          >
            {position > 0 && separator}
            {item.type === "menu" ? (
              <TrailMenu entries={offBar} nameOf={nameOf} onJump={onJump} />
            ) : (
              <Button
                aria-label={nameOf(item.segment.title)}
                className="h-11 min-w-0 justify-start sm:h-11"
                size="xs"
                onClick={() => onJump(item.segment.anchorId)}
                style={{ width: widthOf(item.index) }}
                title={item.segment.title}
                variant="ghost"
              >
                <CrumbText
                  parts={splitReaderHeading(item.segment.title)}
                  withTitle={fitOf(item.index)?.type !== "label"}
                />
              </Button>
            )}
          </li>
        ))}
        {(current !== undefined || rows.length > 0) && (
          // Keep the Contents root and trigger mounted as scrolling changes
          // the path; Base UI associates an open popup with its trigger id.
          <li className="flex min-w-0 shrink-0 items-center">
            {items.length > 0 && separator}
            {contentsControl({
              label:
                current === undefined ? (
                  t("statutes.outline")
                ) : (
                  <CrumbText
                    parts={splitReaderHeading(current.title)}
                    withTitle={currentFit?.type !== "label"}
                  />
                ),
              ...(current === undefined ? {} : { title: current.title }),
              ...(current === undefined
                ? {}
                : { width: widthOf(visible.length - 1) }),
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
