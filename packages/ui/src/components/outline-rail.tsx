/**
 * Outline navigation: an embedded panel, a host-owned rail, or a disclosure.
 *
 * Embedded presentations fill their host track. The standalone disclosure
 * owns a toggle above a thin column of ticks; hovering or pressing it reveals
 * the collapsible tree. Click a tick or a row to jump.
 *
 * Generic over the position source: callers supply `resolvePct` (vertical % for
 * a tick) and `onJump`. Active tracking is derived from `resolvePct` by default,
 * or driven externally via the controlled `activeId` prop (e.g. a virtualised
 * editor that measures rendered anchors itself).
 */

"use client";

import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Temporal } from "temporal-polyfill/full";

import { ChevronRightIcon as ChevronRight, PanelLeftIcon } from "../icons";
import { DOCUMENT_PANEL_SAFE_BOTTOM } from "../lib/panel-inset";
import { cn } from "../lib/utils";
import { DirectionalIcon } from "./directional-icon";
import { ScrollArea } from "./scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/**
 * How prominently an entry reads next to the entries around it. A caller
 * that ranks its entries (a list of search results) steps the near-misses
 * back to `secondary`, so the answer it put first is the row the eye lands on.
 */
export const OUTLINE_EMPHASIS = {
  primary: "primary",
  secondary: "secondary",
} as const;

export type OutlineEmphasis =
  (typeof OUTLINE_EMPHASIS)[keyof typeof OUTLINE_EMPHASIS];

export type OutlineItem = {
  id: string;
  label: string;
  /** What the entry contains, after the label that names it. The label
   *  stays whole; the title is what truncates when the row is narrow. */
  title?: string;
  /** Nesting depth among included items; drives indent + tick taper. */
  level: number;
  /** Optional trailing annotation in the panel (e.g. a page number or a
   *  provision range); never truncated. */
  meta?: string;
  /** Optional CSS custom-property name colouring this entry's tick + chip
   *  (e.g. "--option-blue"). Defaults to the neutral foreground. */
  color?: string;
  /** How prominently the row reads. Defaults to `primary`. */
  emphasis?: OutlineEmphasis;
};

export type OutlineRailProps = {
  items: OutlineItem[];
  scrollContainerRef: RefObject<HTMLElement | null>;
  /** Vertical position (0–100) of an item's tick. Return null to drop it. */
  resolvePct: (id: string, container: HTMLElement) => number | null;
  /** Caller performs the scroll/navigation. */
  onJump: (id: string, container: HTMLElement) => void;
  /** Controlled active id; when omitted, derived from `resolvePct`. */
  activeId?: string | null;
  /** Pinned at the top of the panel, above the tree (e.g. a jump field).
   *  Supplying one also keeps the panel mounted when `items` is short, so a
   *  filter that narrows the tree to nothing cannot take its own control
   *  away; the caller decides whether the document has an outline at all. */
  header?: ReactNode;
  /** Name a trailing annotation for assistive technology and its tooltip. */
  formatMetaLabel?: (meta: string) => string;
  /** Depth from which entries start collapsed. Their ancestors still open on
   *  their own while one of their descendants is active, so a deep outline
   *  reads as the chain down to where the reader is rather than as every
   *  branch at once. Omitted: everything starts expanded. */
  collapsedFromLevel?: number;
  /** `panel` and `rail` fill a host-owned track; `popover` owns its disclosure. */
  presentation?: "panel" | "rail" | "popover";
  /** A host that already reserves docked chrome passes zero. */
  bottomInset?: number;
  topOffset?: number;
  panelWidth?: number;
  ariaLabel?: string;
};

type TreeNode = { item: OutlineItem; index: number; children: TreeNode[] };

export const OUTLINE_CONTROL_MIN_SIZE = 32;
const OUTLINE_CONTROL_TARGET_CLASS =
  "relative pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11";
const RAIL_WIDTH = OUTLINE_CONTROL_MIN_SIZE;
const PANEL_GAP = 6;
const TICK_BASE_WIDTH = 6;
const TICK_LEVEL_STEP = 2;
const TICK_MAX_LEVEL = 5;
// Cap visible ticks by pruning deeper levels; the popover still lists everything.
const RAIL_MAX_TICKS = 40;
// Sub-pixel slack when asking whether the panel can still scroll: a
// fractional scrollHeight would otherwise leave a wheel stuck at an edge that
// reads as one pixel short of its own end.
const WHEEL_EDGE_TOLERANCE = 1;
// Marks the active row for the reveal below: the rows are rendered by a
// recursive walk, so the one to scroll to is found in the committed DOM
// rather than held in a ref the walk would have to thread through.
const ACTIVE_ROW_ATTRIBUTE = "data-outline-active";

/** The entry as one line of text: label, then its title when it has one. */
export const outlineEntryText = (item: OutlineItem): string =>
  item.title === undefined ? item.label : `${item.label} ${item.title}`;

const tickWidth = (level: number): number => {
  const clamped = Math.min(Math.max(level, 0), TICK_MAX_LEVEL);
  return TICK_BASE_WIDTH + (TICK_MAX_LEVEL - clamped) * TICK_LEVEL_STEP;
};

const buildTree = (items: OutlineItem[]): TreeNode[] => {
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];
  for (const [index, item] of items.entries()) {
    const node: TreeNode = { item, index, children: [] };
    let parent = stack.at(-1);
    while (parent && parent.item.level >= item.level) {
      stack.pop();
      parent = stack.at(-1);
    }
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }
  return roots;
};

const tickHeight = (isHovered: boolean, isActive: boolean): number => {
  if (isHovered) {
    return 4;
  }
  if (isActive) {
    return 3;
  }
  return 2;
};

const tickBackground = (
  color: string | undefined,
  isHovered: boolean,
): string => {
  if (color !== undefined) {
    return `var(${color})`;
  }
  if (isHovered) {
    return "var(--option-blue)";
  }
  return "var(--color-foreground)";
};

const EMPHASIS_TEXT_CLASS = {
  primary: "text-foreground",
  secondary: "text-muted-foreground",
} as const satisfies Record<OutlineEmphasis, string>;

/**
 * Rows read in the regular foreground: an outline is text to be read, and a
 * greyed hierarchy is harder to scan than the document it maps. Weight, the
 * active row's fill and the muted trailing range carry the state instead.
 */
const rowTextClass = (isActive: boolean, emphasis: OutlineEmphasis): string =>
  isActive ? "text-foreground font-medium" : EMPHASIS_TEXT_CLASS[emphasis];

// Mirrored under RTL only while collapsed: the open state already rotates the
// chevron down, and mirroring that would tip it the wrong way.
const Chevron = ({ open }: { open: boolean }) => (
  <DirectionalIcon
    className={cn(
      "size-3 shrink-0 transition-transform duration-150",
      open ? "rotate-90" : "rotate-0",
    )}
    flip={!open}
    icon={ChevronRight}
  />
);

export const OutlineRail = ({
  items,
  scrollContainerRef,
  resolvePct,
  onJump,
  activeId,
  header,
  formatMetaLabel,
  collapsedFromLevel,
  presentation = "popover",
  bottomInset,
  topOffset = 0,
  panelWidth = 300,
  ariaLabel = "Outline",
}: OutlineRailProps) => {
  const [pctById, setPctById] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const [derivedActive, setDerivedActive] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  // Held open by keyboard. The pointer path reveals the panel on hover, which
  // a keyboard has no equivalent of, and an `inert` panel cannot take focus to
  // open itself — so the way in is a control outside it that latches this.
  const [pinned, setPinned] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Rows the reader has opened or closed by hand. Their state is theirs: the
  // active-chain auto-expand below must not reopen a branch they just shut.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const panelId = useId();
  const triggerId = useId();
  const panelOpen = presentation === "panel" || hovered || pinned;
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualLockUntil = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  // Hold onJump and the scroll-time resolver in refs so the active-tracking
  // scroll listener reads the latest without re-subscribing. recalc instead
  // depends on resolvePct directly, so ticks recompute when the resolver's
  // output changes (e.g. Folio's docSize); React Compiler keeps the adapters'
  // inline resolvers referentially stable between unrelated renders.
  const resolvePctRef = useRef(resolvePct);
  const onJumpRef = useRef(onJump);

  const tree = useMemo(() => buildTree(items), [items]);

  // Seed the default-collapsed set from the items, and reset it when the
  // items change (a different document). Adjusting state during render rather
  // than in an effect keeps the first paint correct.
  const [seededItems, setSeededItems] = useState<OutlineItem[] | null>(null);
  if (seededItems !== items) {
    setSeededItems(items);
    setToggled(new Set());
    setCollapsed(
      collapsedFromLevel === undefined
        ? new Set()
        : new Set(
            items
              .filter((item) => item.level >= collapsedFromLevel)
              .map((item) => item.id),
          ),
    );
  }

  const maxLevel = useMemo(() => {
    let max = 0;
    for (const item of items) {
      max = Math.max(max, item.level);
    }
    return max;
  }, [items]);

  // Prune deeper levels from the rail (not the panel) when it would be too dense.
  const railLevelCap = useMemo(() => {
    const counts: number[] = [];
    let minLevel = maxLevel;
    for (const item of items) {
      counts[item.level] = (counts[item.level] ?? 0) + 1;
      if (item.level < minLevel) {
        minLevel = item.level;
      }
    }
    // Drop the deepest levels until the rail fits, but never below the
    // shallowest present level: the top headings must stay as ticks so a
    // document that is mostly (or entirely) deep headings keeps a usable rail.
    let cap = maxLevel;
    let running = items.length;
    while (cap > minLevel && running > RAIL_MAX_TICKS) {
      running -= counts[cap] ?? 0;
      cap -= 1;
    }
    return cap;
  }, [items, maxLevel]);

  const recalc = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    const next = new Map<string, number>();
    for (const item of items) {
      const pct = resolvePct(item.id, container);
      if (pct !== null) {
        next.set(item.id, pct);
      }
    }
    setPctById(next);
  }, [items, scrollContainerRef, resolvePct]);

  const recalcRef = useRef(recalc);
  // Keep the latest onJump/resolvePct/recalc in refs so async consumers (scroll
  // listener, ResizeObserver, click handlers) read the current values without
  // re-subscribing. Assigning in a layout effect (rather than during render)
  // keeps refs fresh every commit while staying render-pure.
  useLayoutEffect(() => {
    resolvePctRef.current = resolvePct;
    onJumpRef.current = onJump;
    recalcRef.current = recalc;
  });

  useEffect(() => {
    recalc();
  }, [recalc]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return undefined;
    }
    const observer = new ResizeObserver(() => recalcRef.current());
    observer.observe(container);
    return () => observer.disconnect();
  }, [scrollContainerRef]);

  // Derived active tracking (skipped when caller controls `activeId`).
  useEffect(() => {
    if (activeId !== undefined) {
      return undefined;
    }
    const container = scrollContainerRef.current;
    if (!container || items.length === 0) {
      return undefined;
    }
    let raf = 0;
    const compute = () => {
      if (
        Temporal.Now.instant().epochMilliseconds < manualLockUntil.current ||
        container.scrollHeight <= 0
      ) {
        return;
      }
      const centrePct =
        ((container.scrollTop + container.clientHeight / 2) /
          container.scrollHeight) *
        100;
      let next: string | null = null;
      for (const item of items) {
        const pct = resolvePctRef.current(item.id, container);
        if (pct !== null && pct <= centrePct) {
          next = item.id;
        }
      }
      setDerivedActive(next);
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(compute);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    raf = requestAnimationFrame(compute);
    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener("scroll", onScroll);
    };
  }, [activeId, items, scrollContainerRef]);

  const active = activeId === undefined ? derivedActive : activeId;

  // Ancestors of the active entry, so the chain down to it stays open. Walks
  // the flat list backwards by the same rule `buildTree` nests on: a parent is
  // the nearest preceding entry at a shallower level.
  const activeAncestorIds = useMemo(() => {
    const ancestors = new Set<string>();
    const activeIndex = items.findIndex((item) => item.id === active);
    let level = items.at(activeIndex)?.level;

    if (activeIndex === -1 || level === undefined) {
      return ancestors;
    }

    for (let index = activeIndex - 1; index >= 0 && level > 0; index -= 1) {
      const candidate = items[index];
      if (candidate !== undefined && candidate.level < level) {
        ancestors.add(candidate.id);
        level = candidate.level;
      }
    }

    return ancestors;
  }, [active, items]);

  const jumpTo = useCallback(
    (id: string) => {
      const container = scrollContainerRef.current;
      if (!container) {
        return;
      }
      if (activeId === undefined) {
        setDerivedActive(id);
        manualLockUntil.current =
          Temporal.Now.instant().epochMilliseconds + 900;
      }
      onJumpRef.current(id, container);
    },
    [activeId, scrollContainerRef],
  );

  const toggleCollapse = useCallback(
    (id: string, rowEl: HTMLElement | null) => {
      // Where the toggled row sits now. Content changes only below it, so the
      // row moves only when the panel has to clamp its scroll offset (a branch
      // folding away above the fold); compensate exactly that, and nothing
      // when nothing moved.
      const rowTop = rowEl?.getBoundingClientRect().top;
      setToggled((prev) => new Set(prev).add(id));
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      requestAnimationFrame(() => {
        const panel = panelRef.current;
        if (!panel || !rowEl || rowTop === undefined) {
          return;
        }
        panel.scrollTop += rowEl.getBoundingClientRect().top - rowTop;
      });
    },
    [],
  );

  // Where the controlled active entry sits in the list, and -1 for every state
  // with no row to reveal: no `activeId` (the derived path), a null one, or an
  // id the current `items` no longer hold. Keying the reveal on the position
  // rather than the id also catches the row moving under an unchanged id, which
  // is what a re-ranked result list does.
  const activeIndex = items.findIndex((item) => item.id === activeId);

  // A controlled active entry is one the caller chose — a search selection the
  // reader is moving with the arrow keys, a position an editor measured — so
  // keep it where it can be seen. `nearest` moves the panel only when the row
  // is actually out of view, and the derived (scroll-tracked) active row is
  // left alone: following the reader's own scrolling would fight them.
  useLayoutEffect(() => {
    if (activeIndex === -1 || !panelOpen) {
      return;
    }
    const panel = panelRef.current;
    const row = panel?.querySelector(`[${ACTIVE_ROW_ATTRIBUTE}]`);
    if (!panel || !(row instanceof HTMLElement)) {
      return;
    }
    const panelBox = panel.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (rowBox.top < panelBox.top) {
      panel.scrollTop += rowBox.top - panelBox.top;
    } else if (rowBox.bottom > panelBox.bottom) {
      panel.scrollTop += rowBox.bottom - panelBox.bottom;
    }
  }, [activeIndex, panelOpen]);

  const openPanel = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setHovered(true);
  }, []);

  const scheduleClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
    }
    closeTimer.current = setTimeout(() => setHovered(false), 120);
  }, []);

  // Opening by keyboard has to land the reader in the panel; it is `inert`
  // until this render commits, so the move cannot happen in the click.
  useEffect(() => {
    if (pinned) {
      panelRef.current?.closest("nav")?.focus();
    }
  }, [pinned]);

  const closePanel = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setHovered(false);
    setPinned(false);
  }, []);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current);
      }
    },
    [],
  );

  const renderNode = (node: TreeNode): ReactNode => {
    const hasChildren = node.children.length > 0;
    const isCollapsed =
      collapsed.has(node.item.id) &&
      !(activeAncestorIds.has(node.item.id) && !toggled.has(node.item.id));
    const isActive = active === node.item.id;
    const isHovered = hoveredId === node.item.id;
    const highlighted = isActive || isHovered;
    const indent = 8 + Math.min(node.item.level, maxLevel) * 12;
    return (
      <li key={`${node.item.id}-${node.index}`}>
        <div
          className={cn(
            "flex items-center rounded-md pe-2.5",
            highlighted && "bg-accent",
          )}
          {...(isActive ? { [ACTIVE_ROW_ATTRIBUTE]: "" } : {})}
          onMouseEnter={() => setHoveredId(node.item.id)}
          onMouseLeave={() => setHoveredId(null)}
        >
          {hasChildren ? (
            <button
              aria-expanded={!isCollapsed}
              aria-label={isCollapsed ? "Expand" : "Collapse"}
              className={cn(
                "text-muted-foreground hover:text-foreground flex shrink-0 items-center justify-center",
                OUTLINE_CONTROL_TARGET_CLASS,
              )}
              style={{
                minWidth: OUTLINE_CONTROL_MIN_SIZE,
                minHeight: OUTLINE_CONTROL_MIN_SIZE,
                marginInlineStart: indent - 4,
              }}
              onClick={(event) =>
                toggleCollapse(node.item.id, event.currentTarget.parentElement)
              }
              type="button"
            >
              <Chevron open={!isCollapsed} />
            </button>
          ) : (
            <span
              aria-hidden
              className="shrink-0"
              style={{ width: indent + 4 }}
            />
          )}
          {node.item.color && (
            <span
              aria-hidden
              className="me-1.5 size-1.5 shrink-0 rounded-full"
              style={{ background: `var(${node.item.color})` }}
            />
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-current={isActive ? "true" : undefined}
                  className={cn(
                    "flex min-w-0 flex-1 items-baseline gap-1.5 py-1.5 text-start text-[13px] leading-snug",
                    rowTextClass(
                      isActive,
                      node.item.emphasis ?? OUTLINE_EMPHASIS.primary,
                    ),
                  )}
                  onClick={() => jumpTo(node.item.id)}
                  type="button"
                />
              }
            >
              {node.item.title === undefined ? (
                <span className="min-w-0 truncate">{node.item.label}</span>
              ) : (
                <>
                  <span className="shrink-0 font-medium">
                    {node.item.label}
                  </span>
                  <span className="min-w-0 truncate font-normal">
                    {node.item.title}
                  </span>
                </>
              )}
            </TooltipTrigger>
            <TooltipPopup>{outlineEntryText(node.item)}</TooltipPopup>
          </Tooltip>
          {node.item.meta !== undefined &&
            (formatMetaLabel ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      aria-label={formatMetaLabel(node.item.meta)}
                      className="text-foreground-placeholder text-2xs shrink-0 ps-2 tabular-nums"
                      onClick={() => jumpTo(node.item.id)}
                      type="button"
                    />
                  }
                >
                  {node.item.meta}
                </TooltipTrigger>
                <TooltipPopup>{formatMetaLabel(node.item.meta)}</TooltipPopup>
              </Tooltip>
            ) : (
              <span className="text-foreground-placeholder text-2xs shrink-0 ps-2 tabular-nums">
                {node.item.meta}
              </span>
            ))}
        </div>
        {hasChildren && !isCollapsed && (
          <ul className="m-0 list-none p-0">{node.children.map(renderNode)}</ul>
        )}
      </li>
    );
  };

  const visibleTicks = items.flatMap((item) => {
    const pct = pctById.get(item.id);
    return pct !== undefined && item.level <= railLevelCap
      ? [{ item, pct }]
      : [];
  });

  // Gate on the panel content (every heading), not the pruned tick count. An
  // outline with one shallow heading and many deeper ones leaves <2 ticks but
  // still has a full, navigable popover, so only hide when there is no outline.
  // A header keeps the panel: `items` is then the caller's filtered view, and
  // a filter matching nothing must still leave the field that set it.
  if (items.length < 2 && header === undefined) {
    return null;
  }

  // A pruned sub-topic (no persistent tick) gets an ephemeral "ghost" tick
  // while its panel row is hovered, then drops when the hover moves on.
  const visibleTickIds = new Set(visibleTicks.map(({ item }) => item.id));
  const ghostPct =
    hoveredId !== null && !visibleTickIds.has(hoveredId)
      ? pctById.get(hoveredId)
      : undefined;
  const ghostItem =
    ghostPct === undefined
      ? undefined
      : items.find((item) => item.id === hoveredId);

  return (
    <div
      aria-label={ariaLabel}
      className={OUTLINE_PRESENTATION_CLASS[presentation]}
      role="group"
      style={{
        marginBlockEnd: bottomInset ?? DOCUMENT_PANEL_SAFE_BOTTOM,
        ...(presentation === "popover"
          ? { top: topOffset, bottom: 0, width: RAIL_WIDTH }
          : {}),
      }}
    >
      {/* The disclosure owns a normal-size row above the ticks; a host-owned
          rail supplies its own toggle in that same flow. */}
      {presentation === "popover" && (
        <button
          aria-controls={panelId}
          aria-expanded={panelOpen}
          className={cn(
            "focus-visible:ring-ring bg-popover text-popover-foreground flex shrink-0 items-center justify-center self-start rounded-md focus-visible:ring-2 focus-visible:outline-none",
            "pointer-coarse:my-1.5",
            OUTLINE_CONTROL_TARGET_CLASS,
          )}
          aria-label={ariaLabel}
          style={{
            minWidth: OUTLINE_CONTROL_MIN_SIZE,
            minHeight: OUTLINE_CONTROL_MIN_SIZE,
          }}
          id={triggerId}
          onClick={() => {
            if (pinned) {
              closePanel();
              return;
            }
            setPinned(true);
            openPanel();
          }}
          type="button"
        >
          <PanelLeftIcon aria-hidden className="size-4 rtl:-scale-x-100" />
        </button>
      )}
      {presentation !== "panel" && (
        <div
          className="relative min-h-0 flex-1"
          data-outline-ticks
          style={
            presentation === "popover"
              ? { height: `calc(100% - ${OUTLINE_CONTROL_MIN_SIZE}px)` }
              : undefined
          }
          onMouseEnter={openPanel}
          onMouseLeave={scheduleClose}
          onWheel={(event) => {
            scrollContainerRef.current?.scrollBy(0, event.deltaY);
          }}
        >
          {visibleTicks.map(({ item, pct }) => {
            const isActive = active === item.id;
            const isHovered = hoveredId === item.id;
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger
                  render={
                    <button
                      aria-current={isActive ? "true" : undefined}
                      aria-label={item.label}
                      className={cn(
                        "absolute end-0 rounded-full transition-[width,height,opacity] duration-150",
                        isHovered || isActive
                          ? "opacity-100"
                          : "opacity-45 hover:opacity-90",
                      )}
                      onClick={() => jumpTo(item.id)}
                      onMouseEnter={() => setHoveredId(item.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      style={{
                        top: `clamp(2px, ${pct}%, calc(100% - 2px))`,
                        transform: "translateY(-50%)",
                        width: isHovered
                          ? tickWidth(item.level) + 8
                          : tickWidth(item.level),
                        height: tickHeight(isHovered, isActive),
                        background: tickBackground(item.color, isHovered),
                      }}
                      type="button"
                    />
                  }
                />
                <TooltipPopup>{item.label}</TooltipPopup>
              </Tooltip>
            );
          })}
          {ghostItem && ghostPct !== undefined && (
            <span
              aria-hidden
              className="absolute end-0 rounded-full opacity-100"
              style={{
                top: `clamp(2px, ${ghostPct}%, calc(100% - 2px))`,
                transform: "translateY(-50%)",
                width: tickWidth(ghostItem.level) + 8,
                height: 4,
                background: ghostItem.color
                  ? `var(${ghostItem.color})`
                  : "var(--option-blue)",
              }}
            />
          )}
        </div>
      )}

      {presentation !== "rail" && (
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- hover-reveal disclosure on a nav landmark; panel visibility gated by inert/aria-hidden
        <nav
          aria-label={ariaLabel}
          aria-hidden={!panelOpen}
          id={panelId}
          inert={panelOpen ? undefined : true}
          tabIndex={-1}
          className={cn(
            "bg-popover text-popover-foreground flex min-h-0 flex-col",
            presentation === "popover" &&
              "border-border absolute rounded-xl border shadow-lg transition-[opacity,transform] duration-150",
            outlinePanelVisibilityClass(presentation, panelOpen),
          )}
          // A control in the header is reachable by keyboard once the panel is
          // open, and typing in it moves the pointer nowhere: hold the panel
          // open for as long as focus is inside it, or `inert` would take the
          // focused control away mid-keystroke.
          onBlurCapture={(event) => {
            // A panel latched open by keyboard releases when focus leaves it;
            // the hover path keeps its grace period so a click inside the panel
            // (blur, then focus) does not flicker it shut.
            if (pinned && !event.currentTarget.contains(event.relatedTarget)) {
              closePanel();
              return;
            }
            scheduleClose();
          }}
          onFocusCapture={openPanel}
          onKeyDown={(event) => {
            if (event.key !== "Escape") {
              return;
            }
            // Closing makes this panel inert, which would leave focus nowhere.
            // Hand it back to the control that opened it, before that happens.
            const trigger = event.currentTarget.ownerDocument.querySelector(
              `#${CSS.escape(triggerId)}`,
            );
            if (trigger instanceof HTMLElement) {
              trigger.focus();
            }
            closePanel();
          }}
          onMouseEnter={openPanel}
          onMouseLeave={scheduleClose}
          onWheel={(event) => {
            // The panel is a lens over the document, not a modal: a wheel it
            // cannot use must still scroll the text behind it. A short outline
            // has no overflow to consume at all, and a long one stops consuming
            // at its own ends — and the document's scroller is a sibling, not an
            // ancestor, so the browser's own scroll chaining never reaches it.
            const panel = panelRef.current;
            if (!panel) {
              return;
            }
            const room = panel.scrollHeight - panel.clientHeight;
            const consumes =
              room > WHEEL_EDGE_TOLERANCE &&
              (event.deltaY < 0
                ? panel.scrollTop > WHEEL_EDGE_TOLERANCE
                : panel.scrollTop < room - WHEEL_EDGE_TOLERANCE);

            if (consumes) {
              return;
            }

            scrollContainerRef.current?.scrollBy(0, event.deltaY);
          }}
          style={
            presentation === "popover"
              ? {
                  top: 0,
                  insetInlineEnd: RAIL_WIDTH + PANEL_GAP,
                  width: `min(${panelWidth}px, calc(100vw - ${RAIL_WIDTH + PANEL_GAP + 16}px))`,
                  height: "calc(100% - 24px)",
                }
              : undefined
          }
        >
          {header !== undefined && (
            <div className="bg-popover z-50 shrink-0 border-b p-2">
              {header}
            </div>
          )}
          <ScrollArea
            axis="vertical"
            className="min-h-0 flex-1"
            viewportRef={panelRef}
          >
            <ul className="m-0 list-none p-0 pb-2">{tree.map(renderNode)}</ul>
          </ScrollArea>
        </nav>
      )}
    </div>
  );
};

const OUTLINE_PRESENTATION_CLASS = {
  popover: "absolute end-0 z-20 flex flex-col pointer-coarse:min-w-11",
  panel: "relative flex min-h-0 w-full flex-1 flex-col",
  rail: "relative flex min-h-0 w-full flex-1 flex-col",
} as const satisfies Record<
  NonNullable<OutlineRailProps["presentation"]>,
  string
>;

function outlinePanelVisibilityClass(
  presentation: NonNullable<OutlineRailProps["presentation"]>,
  open: boolean,
): string {
  if (presentation === "panel") {
    return "flex-1";
  }
  return open
    ? "translate-x-0 opacity-100"
    : "pointer-events-none translate-x-2 opacity-0";
}
