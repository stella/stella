import { useId, useState } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { panic } from "better-result";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  parseDocumentAst,
  resolveDocumentHeadingAnchor,
} from "@stll/legal-ast/document-ast";
import type { Block } from "@stll/legal-ast/document-ast";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

// The move flash is the reader's own `[data-highlight]` animation.
import "@/components/legal-reader/reader.css";
import { SourceLinkPolicyProvider } from "@/components/legal-reader/source-link-policy";
import {
  StatuteBlock,
  StatuteMasthead,
} from "@/features/statutes/components/statute-text";
import { StatuteValidityIndicator } from "@/features/statutes/components/statute-validity-indicator";
import { provisionInVersionOptions } from "@/features/statutes/queries/provision-preview";
import { statuteOptions } from "@/features/statutes/queries/statutes";
import type {
  PublicStatute,
  PublicStatuteVersion,
} from "@/features/statutes/queries/statutes";
import {
  actCompareSide,
  compareStatuteBlocks,
  groupCompareRows,
  locateCompareRows,
  pairCompareSides,
  provisionCompareSide,
  resolveCompareVersions,
  visibleCompareGroups,
} from "@/features/statutes/statute-compare";
import type {
  CompareRowLocation,
  CompareSideState,
  PairedCompareSides,
  StatuteCompareGroup,
  StatuteCompareMove,
  StatuteCompareRow,
} from "@/features/statutes/statute-compare";
import { STATUTE_COMPARE_SHOW } from "@/features/statutes/statute-compare-search";
import type {
  StatuteCompareSearch,
  StatuteCompareShow,
} from "@/features/statutes/statute-compare-search";
import { compareText, markSide } from "@/features/statutes/statute-diff-marks";
import type { StatuteCompareSide } from "@/features/statutes/statute-diff-marks";
import { formatValidityDate } from "@/features/statutes/statute-format";
import {
  paragraphFromPreview,
  prepareStatuteReader,
} from "@/features/statutes/statute-reader-blocks";
import type {
  PreviewBlock,
  StatuteMasthead as StatuteMastheadData,
} from "@/features/statutes/statute-reader-blocks";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";

const READER_STYLE = {
  fontFamily: "var(--reader-body-font)",
  fontSize: "var(--reader-body-size)",
  lineHeight: "var(--reader-body-line-height)",
} as const;

const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f"] as const;

/** A provision with a paragraph or two; measured once it renders. */
// A group is estimated from its text, not a flat guess: a flat guess makes
// the total height grow as long provisions are measured, so the scrollbar
// shrinks under the reader's pointer. Tuned to the two-column reader width
// and the reader's own type: body lines at its line height, heading lines
// set larger, with the gap the designation row keeps from its title.
const GROUP_PADDING_PX = 24;
const ROW_GAP_PX = 12;
const LINE_HEIGHT_PX = 28;
const CHARS_PER_LINE = 62;
const HEADING_LINE_HEIGHT_PX = 32;
const HEADING_LINE_GAP_PX = 12;
const HEADING_CHARS_PER_LINE = 44;
const GROUP_OVERSCAN = 6;

type CompareNavigate = (next: StatuteCompareSearch) => void;

type StatuteCompareViewProps = {
  /**
   * The consolidation the route resolved, and its already-parsed blocks:
   * null when its AST is absent or unparseable and the reader prints its
   * plain text instead.
   */
  onScreen: PublicStatute;
  onScreenBlocks: readonly Block[] | null;
  versions: readonly PublicStatuteVersion[];
  /** The other consolidation's opening day, from the `compare` param. */
  compare: string;
  provision: string | undefined;
  show: StatuteCompareShow;
  onNavigate: CompareNavigate;
};

/**
 * Two consolidations of one act side by side: the older wording on the left
 * with what was removed struck through, the newer on the right with what was
 * added marked, aligned row by row. The whole act, or one provision of it.
 */
export const StatuteCompareView = ({
  compare,
  onNavigate,
  onScreen,
  onScreenBlocks,
  provision,
  show,
  versions,
}: StatuteCompareViewProps) => {
  const t = useTranslations();
  const resolved = resolveCompareVersions({
    compare,
    onScreenId: onScreen.id,
    versions,
  });
  const close = () =>
    onNavigate({ compare: undefined, provision: undefined, show: undefined });

  switch (resolved.type) {
    case "missing":
      return (
        <CompareNotice onClose={close}>
          {t("statutes.compareVersionMissing")}
        </CompareNotice>
      );
    case "same":
      return (
        <CompareNotice onClose={close}>
          {t("statutes.compareSameVersion")}
        </CompareNotice>
      );
    case "ready":
      break;
    default:
      resolved satisfies never;
      return panic("Unhandled statute comparison state");
  }

  const frame = {
    language: onScreen.language,
    newer: resolved.newer,
    older: resolved.older,
    onClose: close,
  };

  // Both consolidations are the same act from the same publisher, so its
  // links answer to the one policy the reader applies.
  return (
    <SourceLinkPolicyProvider urls={[onScreen.documentUrl, onScreen.sourceUrl]}>
      {provision === undefined ? (
        <ActComparison
          frame={frame}
          onScreen={onScreen}
          onScreenBlocks={onScreenBlocks}
          onShowChange={(next) =>
            onNavigate({ compare, provision, show: next })
          }
          other={resolved.other}
          show={show}
        />
      ) : (
        <ProvisionComparison
          frame={frame}
          onScreen={onScreen}
          onScreenBlocks={onScreenBlocks}
          onWholeAct={() =>
            onNavigate({ compare, provision: undefined, show: undefined })
          }
          other={resolved.other}
          provision={provision}
        />
      )}
    </SourceLinkPolicyProvider>
  );
};

type CompareFrame = {
  /** The act's language, which its wording is set in. */
  language: string;
  older: PublicStatuteVersion;
  newer: PublicStatuteVersion;
  onClose: () => void;
};

type OrderSidesOptions = {
  frame: CompareFrame;
  onScreen: CompareSideState;
  onScreenId: string;
  other: CompareSideState;
};

/** The two sides in reading order: older on the left, newer on the right. */
const orderSides = ({
  frame,
  onScreen,
  onScreenId,
  other,
}: OrderSidesOptions): PairedCompareSides =>
  frame.newer.id === onScreenId
    ? pairCompareSides({ newer: onScreen, older: other })
    : pairCompareSides({ newer: other, older: onScreen });

const readyBlocks = (blocks: readonly Block[]): CompareSideState => ({
  type: "ready",
  blocks,
});

type ActComparisonProps = {
  frame: CompareFrame;
  onScreen: PublicStatute;
  onScreenBlocks: readonly Block[] | null;
  onShowChange: (show: StatuteCompareShow) => void;
  other: PublicStatuteVersion;
  show: StatuteCompareShow;
};

/**
 * The whole act. The consolidation on screen is already in memory; only the
 * other one is read, once the reader asks for the comparison.
 */
const ActComparison = ({
  frame,
  onScreen,
  onScreenBlocks,
  onShowChange,
  other,
  show,
}: ActComparisonProps) => {
  const t = useTranslations();
  const showUnchangedId = useId();
  const { data, isError } = useQuery(statuteOptions(other.id));
  // One title for both sides: the masthead is found by the act's citation,
  // which no consolidation changes. The masthead the reader lifts out of the
  // text is not compared: it names the act, which both sides share, so it is
  // shown once, above the rows, when the reader asks for the unchanged text.
  const sides = orderSides({
    frame,
    onScreen: actCompareSide({
      blocks: onScreenBlocks,
      statuteTitle: onScreen.title,
    }),
    onScreenId: onScreen.id,
    other:
      data === undefined
        ? { type: "loading" }
        : actCompareSide({
            blocks: parseDocumentAst(data.documentAst)?.blocks ?? null,
            statuteTitle: onScreen.title,
          }),
  });
  const masthead =
    show === STATUTE_COMPARE_SHOW.all && onScreenBlocks !== null
      ? prepareStatuteReader({
          blocks: onScreenBlocks,
          statuteTitle: onScreen.title,
        }).masthead
      : null;

  return (
    <CompareFrameLayout
      actions={
        <label
          className="text-muted-foreground flex items-center gap-2 text-xs"
          htmlFor={showUnchangedId}
        >
          <Checkbox
            checked={show === STATUTE_COMPARE_SHOW.all}
            id={showUnchangedId}
            onCheckedChange={(checked) =>
              onShowChange(
                checked
                  ? STATUTE_COMPARE_SHOW.all
                  : STATUTE_COMPARE_SHOW.changed,
              )
            }
          />
          {t("statutes.compareShowUnchanged")}
        </label>
      }
      frame={frame}
      title={t("statutes.compareTitle")}
    >
      <CompareBody
        failed={isError}
        frame={frame}
        masthead={masthead}
        show={show}
        sides={sides}
      />
    </CompareFrameLayout>
  );
};

type ProvisionComparisonProps = {
  frame: CompareFrame;
  onScreen: PublicStatute;
  onScreenBlocks: readonly Block[] | null;
  onWholeAct: () => void;
  other: PublicStatuteVersion;
  provision: string;
};

/**
 * One provision. The other consolidation's wording comes from the provision
 * read, so a comparison opened from a provision's history never downloads the
 * rest of the act; the on-screen side is narrowed by the same rule the API
 * applies. Either side may lack the provision altogether.
 */
const ProvisionComparison = ({
  frame,
  onScreen,
  onScreenBlocks,
  onWholeAct,
  other,
  provision,
}: ProvisionComparisonProps) => {
  const t = useTranslations();
  const { data, isError } = useQuery(
    provisionInVersionOptions({ anchor: provision, documentId: other.id }),
  );
  const heading =
    onScreenBlocks === null
      ? null
      : resolveDocumentHeadingAnchor(onScreenBlocks, provision);
  const sides = orderSides({
    frame,
    onScreen: provisionCompareSide({ blocks: onScreenBlocks, provision }),
    onScreenId: onScreen.id,
    other: otherProvisionSide(data),
  });

  return (
    <CompareFrameLayout
      actions={
        <Button onClick={onWholeAct} size="sm" variant="ghost">
          {t("statutes.compareWholeAct")}
        </Button>
      }
      frame={frame}
      title={
        heading === null
          ? t("statutes.compareTitle")
          : t("statutes.compareProvisionTitle", {
              provision: heading.plainText,
            })
      }
    >
      <CompareBody
        failed={isError}
        frame={frame}
        masthead={null}
        show={STATUTE_COMPARE_SHOW.all}
        sides={sides}
      />
    </CompareFrameLayout>
  );
};

type ProvisionWording = {
  blocks: readonly PreviewBlock[];
};

/** The provision read's answer: still loading, not in that version, or its wording. */
const otherProvisionSide = (
  data: ProvisionWording | null | undefined,
): CompareSideState => {
  if (data === undefined) {
    return { type: "loading" };
  }
  if (data === null) {
    return { type: "absent" };
  }

  return readyBlocks(data.blocks.map(paragraphFromPreview));
};

type CompareFrameLayoutProps = {
  actions: ReactNode;
  children: ReactNode;
  frame: CompareFrame;
  title: string;
};

/**
 * The comparison's chrome stays put and only the rows scroll: the column
 * heads are what make a row far down the act legible.
 */
const CompareFrameLayout = ({
  actions,
  children,
  frame,
  title,
}: CompareFrameLayoutProps) => {
  const t = useTranslations();

  return (
    // Pinned to the reader pane rather than sized by percentage: the pane's
    // height is not definite for every ancestor chain, and an unbounded frame
    // lets the page scroll around the list's own scroll area.
    <section aria-label={title} className="absolute inset-0 flex flex-col">
      <div className="mx-auto flex w-full flex-col px-4 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2 pt-4 pb-2">
          <h2 className="text-sm font-medium text-balance">{title}</h2>
          <div className="flex flex-wrap items-center gap-3">
            {actions}
            <Button onClick={frame.onClose} size="sm" variant="ghost">
              <XIcon className="size-3.5" />
              {t("statutes.compareClose")}
            </Button>
          </div>
        </div>
        {/* Stacked, every cell names its own version instead. */}
        <div className="hidden grid-cols-2 gap-x-8 border-b py-2 md:grid">
          <StatuteValidityIndicator
            status={frame.older.status}
            validFrom={frame.older.versionValidFrom}
            validTo={frame.older.versionValidTo}
          />
          <StatuteValidityIndicator
            status={frame.newer.status}
            validFrom={frame.newer.versionValidFrom}
            validTo={frame.newer.versionValidTo}
          />
        </div>
      </div>
      {children}
    </section>
  );
};

type CompareBodyProps = {
  failed: boolean;
  frame: CompareFrame;
  /** The act's front matter, set above the rows; null to leave it out. */
  masthead: StatuteMastheadData | null;
  show: StatuteCompareShow;
  sides: PairedCompareSides;
};

const CompareBody = ({
  failed,
  frame,
  masthead,
  show,
  sides,
}: CompareBodyProps) => {
  const t = useTranslations();

  if (failed) {
    return <CompareMessage>{t("statutes.compareUnavailable")}</CompareMessage>;
  }

  switch (sides.type) {
    case "loading":
      return <CompareSkeleton />;
    case "unstructured":
      return (
        <CompareMessage>{t("statutes.compareUnstructured")}</CompareMessage>
      );
    case "neither":
      return (
        <CompareMessage>{t("statutes.compareProvisionNeither")}</CompareMessage>
      );
    case "olderOnly":
    case "newerOnly":
      return <OneSidedComparison frame={frame} sides={sides} />;
    case "both":
      return (
        <TwoSidedComparison
          frame={frame}
          masthead={masthead}
          show={show}
          sides={sides}
        />
      );
    default:
      sides satisfies never;
      return panic("Unhandled comparison sides");
  }
};

type TwoSidedComparisonProps = {
  frame: CompareFrame;
  masthead: StatuteMastheadData | null;
  show: StatuteCompareShow;
  sides: Extract<PairedCompareSides, { type: "both" }>;
};

const TwoSidedComparison = ({
  frame,
  masthead,
  show,
  sides,
}: TwoSidedComparisonProps) => {
  const t = useTranslations();
  const compared = compareStatuteBlocks(sides);

  if (compared.isErr()) {
    return <CompareMessage>{t("statutes.compareUnavailable")}</CompareMessage>;
  }

  const groups = visibleCompareGroups(groupCompareRows(compared.value), show);

  if (groups.length === 0) {
    return <CompareMessage>{t("statutes.compareNoChanges")}</CompareMessage>;
  }

  return (
    <VirtualCompareGroups frame={frame} groups={groups} masthead={masthead} />
  );
};

type FlashedRow = {
  key: string;
  /** Bumped per jump, so jumping to the same row again replays the flash. */
  nonce: number;
};

type VirtualCompareGroupsProps = {
  frame: CompareFrame;
  groups: readonly StatuteCompareGroup[];
  masthead: StatuteMastheadData | null;
};

type LineMetrics = {
  charsPerLine: number;
  /** Between the lines a break starts, on top of the line itself. */
  lineGap: number;
  lineHeight: number;
};

const LINE_METRICS = {
  heading: {
    charsPerLine: HEADING_CHARS_PER_LINE,
    lineGap: HEADING_LINE_GAP_PX,
    lineHeight: HEADING_LINE_HEIGHT_PX,
  },
  text: {
    charsPerLine: CHARS_PER_LINE,
    lineGap: 0,
    lineHeight: LINE_HEIGHT_PX,
  },
} as const satisfies Record<StatuteCompareRow["type"], LineMetrics>;

const estimateSideHeight = (
  side: StatuteCompareSide | null,
  metrics: LineMetrics,
): number => {
  if (side === null) {
    return 0;
  }
  const lines = side.segments
    .map((segment) => segment.text)
    .join("")
    .split("\n");
  const wrapped = lines.reduce(
    (count, line) =>
      count + Math.max(1, Math.ceil(line.length / metrics.charsPerLine)),
    0,
  );

  return wrapped * metrics.lineHeight + (lines.length - 1) * metrics.lineGap;
};

const estimateRowHeight = (row: StatuteCompareRow): number => {
  const metrics = LINE_METRICS[row.type];

  return (
    ROW_GAP_PX +
    Math.max(
      estimateSideHeight(row.before, metrics),
      estimateSideHeight(row.after, metrics),
    )
  );
};

const estimateGroupHeight = (group: StatuteCompareGroup | undefined): number =>
  GROUP_PADDING_PX +
  (group?.rows.reduce((height, row) => height + estimateRowHeight(row), 0) ??
    0);

/**
 * The rows, one virtual item per provision. A whole act listed in full is
 * thousands of rows, so only the provisions near the viewport are mounted;
 * the browser's find therefore only reaches what is on screen.
 */
const VirtualCompareGroups = ({
  frame,
  groups,
  masthead,
}: VirtualCompareGroupsProps) => {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );
  // The masthead scrolls with the rows, so the list starts below it; the
  // virtualizer is told its height to place the rows after it.
  const [mastheadHeight, setMastheadHeight] = useState(0);
  const measureMasthead = (element: HTMLDivElement | null) => {
    const height = element?.offsetHeight ?? 0;
    if (height !== mastheadHeight) {
      setMastheadHeight(height);
    }
  };
  const [flashed, setFlashed] = useState<FlashedRow | null>(null);
  const locations = locateCompareRows(groups);
  const virtualizer = useVirtualizer({
    count: groups.length,
    enabled: scrollElement !== null,
    estimateSize: (index) => estimateGroupHeight(groups.at(index)),
    getItemKey: (index) => groups.at(index)?.key ?? index,
    getScrollElement: () => scrollElement,
    overscan: GROUP_OVERSCAN,
    scrollMargin: mastheadHeight,
  });
  const items = virtualizer.getVirtualItems();
  // Item offsets include the scroll margin; the spacers sit below the
  // masthead, so they measure from where the list starts.
  const paddingTop = (items.at(0)?.start ?? mastheadHeight) - mastheadHeight;
  const paddingBottom =
    virtualizer.getTotalSize() -
    ((items.at(-1)?.end ?? mastheadHeight) - mastheadHeight);

  const jumpTo = (rowKey: string) => {
    const location =
      locations.get(rowKey) ?? panic("A move points at a row not listed");
    virtualizer.scrollToIndex(location.groupIndex, { align: "center" });
    setFlashed((previous) => ({
      key: rowKey,
      nonce: (previous?.nonce ?? 0) + 1,
    }));
  };

  return (
    <ScrollArea
      axis="vertical"
      className="min-h-0 flex-1"
      viewportRef={setScrollElement}
    >
      <article
        className="reader-statute text-card-foreground mx-auto w-full px-4 pb-16 text-start md:px-8"
        style={READER_STYLE}
      >
        {masthead === null ? null : (
          <div className="flow-root pt-6" ref={measureMasthead}>
            <StatuteMasthead masthead={masthead} />
          </div>
        )}
        <div aria-hidden="true" style={{ height: paddingTop }} />
        {items.map((item) => {
          const group = groups.at(item.index);

          if (group === undefined) {
            return null;
          }

          return (
            <div
              className="py-3"
              data-index={item.index}
              key={item.key}
              ref={virtualizer.measureElement}
            >
              {group.rows.map((row) => (
                <CompareRow
                  flashNonce={flashed?.key === row.key ? flashed.nonce : null}
                  frame={frame}
                  key={row.key}
                  layout={GROUP_LAYOUT[group.status]}
                  locations={locations}
                  onJump={jumpTo}
                  row={row}
                />
              ))}
            </div>
          );
        })}
        <div aria-hidden="true" style={{ height: paddingBottom }} />
      </article>
    </ScrollArea>
  );
};

/**
 * How a row is set: once down the middle (`shared`), or each version in its
 * own column (`split`).
 */
type CompareRowLayout = "shared" | "split";

/**
 * Decided per provision, not per row: a provision that changed anywhere is
 * read side by side whole, its unchanged paragraphs and letters included, so
 * the reader never loses which column a changed letter belongs to. Only a
 * provision both versions share is said once.
 */
const GROUP_LAYOUT = {
  changed: "split",
  unchanged: "shared",
} as const satisfies Record<StatuteCompareGroup["status"], CompareRowLayout>;

type CompareRowProps = {
  /** Set while this row is the one a move jumped to. */
  flashNonce: number | null;
  frame: CompareFrame;
  layout: CompareRowLayout;
  locations: ReadonlyMap<string, CompareRowLocation>;
  onJump: (rowKey: string) => void;
  row: StatuteCompareRow;
};

const CompareRow = ({
  flashNonce,
  frame,
  layout,
  locations,
  onJump,
  row,
}: CompareRowProps) => {
  const cells = (
    <RowCells
      frame={frame}
      layout={layout}
      locations={locations}
      onJump={onJump}
      row={row}
    />
  );

  // Remounting on each jump restarts the flash animation.
  return flashNonce === null ? (
    <div className="grid gap-x-8 gap-y-1 py-1 md:grid-cols-2">{cells}</div>
  ) : (
    <div
      className="grid gap-x-8 gap-y-1 py-1 md:grid-cols-2"
      data-highlight=""
      key={flashNonce}
    >
      {cells}
    </div>
  );
};

const RowCells = ({
  frame,
  layout,
  locations,
  onJump,
  row,
}: Omit<CompareRowProps, "flashNonce">) => {
  switch (layout) {
    case "shared":
      return (
        <div className="md:col-span-2 md:mx-auto md:w-1/2">
          <CompareCell
            frame={frame}
            locations={locations}
            onJump={onJump}
            row={row}
            side="newer"
          />
        </div>
      );
    case "split":
      return (
        <>
          <CompareCell
            frame={frame}
            locations={locations}
            onJump={onJump}
            row={row}
            side="older"
          />
          <CompareCell
            frame={frame}
            locations={locations}
            onJump={onJump}
            row={row}
            side="newer"
          />
        </>
      );
    default:
      layout satisfies never;
      return panic("Unhandled comparison row layout");
  }
};

type CompareCellProps = {
  frame: CompareFrame;
  locations: ReadonlyMap<string, CompareRowLocation>;
  onJump: (rowKey: string) => void;
  row: StatuteCompareRow;
  side: "older" | "newer";
};

const CompareCell = ({
  frame,
  locations,
  onJump,
  row,
  side,
}: CompareCellProps) => {
  const t = useTranslations();
  const version = side === "older" ? frame.older : frame.newer;
  const wording = side === "older" ? row.before : row.after;

  if (wording !== null) {
    return (
      <div className="min-w-0">
        <VersionName version={version} />
        <div className={cn(row.move !== null && "border-s-2 ps-3")}>
          {row.move === null ? null : (
            <span className="sr-only">{t("statutes.compareMoved")}</span>
          )}
          <ReaderBlocks language={frame.language} side={wording} />
        </div>
      </div>
    );
  }

  if (row.move !== null) {
    const here =
      locations.get(row.key) ?? panic("A listed row has no location");
    const there =
      locations.get(row.move.counterpartKey) ??
      panic("A move points at a row not listed");

    const { counterpartKey } = row.move;

    return (
      <div className="min-w-0">
        <VersionName version={version} />
        <MoveMarker
          end={row.move.end}
          onJump={() => onJump(counterpartKey)}
          provision={there.provision}
          upward={there.groupIndex < here.groupIndex}
        />
      </div>
    );
  }

  return (
    <div className="bg-muted/40 min-h-6 rounded-md">
      <VersionName version={version} />
      <span className="sr-only">{t("statutes.compareAbsent")}</span>
    </div>
  );
};

/**
 * One side's blocks, set by the reader's own renderer with the diff marked
 * inside them. The reader spaces blocks by their own margins, which in a
 * cell would stack onto the row's; the row keeps the rhythm instead, and a
 * cell holding several blocks (a paragraph split in two) spaces them as the
 * reader spaces paragraphs.
 */
const ReaderBlocks = ({
  language,
  side,
}: {
  /** The act's language; the chrome around the cell is the reader's own. */
  language: string;
  side: StatuteCompareSide;
}) => (
  <div
    className="flex flex-col gap-[var(--reader-paragraph-gap)] *:my-0"
    lang={language}
  >
    {markSide(side).map(({ block, rangesByPieceId }) => (
      <StatuteBlock
        anchorPresentation="embedded"
        block={block}
        key={block.id}
        rangesByPieceId={rangesByPieceId}
      />
    ))}
  </div>
);

/** What a move's marker says at each end, with and without a provision to name. */
const MOVE_LABEL_KEYS = {
  source: {
    named: "statutes.compareMovedTo",
    unnamed: "statutes.compareMovedToElsewhere",
  },
  target: {
    named: "statutes.compareMovedFrom",
    unnamed: "statutes.compareMovedFromElsewhere",
  },
} as const satisfies Record<
  StatuteCompareMove["end"],
  { named: TranslationKey; unnamed: TranslationKey }
>;

type MoveMarkerProps = {
  end: StatuteCompareMove["end"];
  onJump: () => void;
  provision: string | null;
  upward: boolean;
};

/** Where a moved paragraph went, or came from, and a way to go there. */
const MoveMarker = ({ end, onJump, provision, upward }: MoveMarkerProps) => {
  const t = useTranslations();
  const Arrow = upward ? ArrowUpIcon : ArrowDownIcon;
  const keys = MOVE_LABEL_KEYS[end];
  const label =
    provision === null ? t(keys.unnamed) : t(keys.named, { provision });

  return (
    <Button onClick={onJump} size="sm" variant="outline">
      <Arrow className="size-3.5" />
      {label}
    </Button>
  );
};

/**
 * Side by side, the column heads name the versions and this stays for screen
 * readers; stacked, the heads are gone and every cell shows it.
 */
const VersionName = ({ version }: { version: PublicStatuteVersion }) => {
  const t = useTranslations();
  const format = useFormatter();
  const date = formatValidityDate(version.versionValidFrom, format);

  if (date === null) {
    return null;
  }

  return (
    <span className="text-muted-foreground text-2xs block md:sr-only">
      {t("statutes.inForceSince", { date })}
    </span>
  );
};

type OneSidedComparisonProps = {
  frame: CompareFrame;
  sides: Extract<PairedCompareSides, { type: "olderOnly" | "newerOnly" }>;
};

/**
 * A provision only one consolidation carries: its wording on that side, and
 * on the other a plain statement that it was not there, rather than a diff
 * that would mark every word as inserted or deleted.
 */
const OneSidedComparison = ({ frame, sides }: OneSidedComparisonProps) => {
  const t = useTranslations();
  const notice = (
    <p className="text-muted-foreground bg-muted/40 rounded-md p-3 text-sm">
      {sides.type === "newerOnly"
        ? t("statutes.compareAddedLater")
        : t("statutes.compareNoLongerPresent")}
    </p>
  );
  const wording = (
    <ReaderBlocks
      language={frame.language}
      side={{
        blocks: sides.blocks,
        segments: [{ type: "equal", text: compareText(sides.blocks) }],
      }}
    />
  );

  return (
    <ScrollArea axis="vertical" className="min-h-0 flex-1">
      <article
        className="reader-statute text-card-foreground mx-auto grid w-full gap-x-8 gap-y-3 px-4 py-3 pb-16 text-start md:grid-cols-2 md:px-8"
        style={READER_STYLE}
      >
        <div className="min-w-0">
          <VersionName version={frame.older} />
          {sides.type === "newerOnly" ? notice : wording}
        </div>
        <div className="min-w-0">
          <VersionName version={frame.newer} />
          {sides.type === "newerOnly" ? wording : notice}
        </div>
      </article>
    </ScrollArea>
  );
};

const CompareMessage = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground py-16 text-center text-sm">{children}</p>
);

const CompareNotice = ({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) => {
  const t = useTranslations();

  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-muted-foreground text-sm">{children}</p>
      <Button onClick={onClose} size="sm" variant="outline">
        {t("statutes.compareClose")}
      </Button>
    </div>
  );
};

const CompareSkeleton = () => (
  <div className="mx-auto flex w-full flex-col gap-4 px-4 py-3 md:px-8">
    {SKELETON_ROWS.map((key) => (
      <div className="grid gap-x-8 gap-y-2 md:grid-cols-2" key={key}>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    ))}
  </div>
);
