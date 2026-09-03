/**
 * Outline rail — the shared right-edge navigation rail.
 *
 * Always-visible thin column of ticks (width tapering by nesting level).
 * Hovering reveals a single popover panel with the outline as a collapsible
 * tree; the entry currently in view is emphasised. Click a tick or a row to
 * jump.
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

import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

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
  /** Depth from which entries start collapsed. Their ancestors still open on
   *  their own while one of their descendants is active, so a deep outline
   *  reads as the chain down to where the reader is rather than as every
   *  branch at once. Omitted: everything starts expanded. */
  collapsedFromLevel?: number;
  topOffset?: number;
  panelWidth?: number;
  ariaLabel?: string;
};

type TreeNode = { item: OutlineItem; index: number; children: TreeNode[] };

const RAIL_WIDTH = 20;
const PANEL_GAP = 6;
// Popover row height (~29.9px). Parent rows stick at multiples of this so the
// ancestor chain stacks at the top; set a hair UNDER the real height so stacked
// headers slightly overlap (opaque) rather than leave a sub-pixel gap.
const ROW_H = 29;
const TICK_BASE_WIDTH = 6;
const TICK_LEVEL_STEP = 2;
const TICK_MAX_LEVEL = 5;
// Cap visible ticks by pruning deeper levels; the popover still lists everything.
const RAIL_MAX_TICKS = 40;

/** The entry as one line of text: label, then its title when it has one. */
const entryText = (item: OutlineItem): string =>
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

const rowTextClass = (isActive: boolean, hasChildren: boolean): string => {
  if (isActive) {
    return "text-foreground font-medium";
  }
  if (hasChildren) {
    return "text-foreground-muted";
  }
  return "text-muted-foreground";
};

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    aria-hidden
    className={cn(
      "size-3 shrink-0 transition-transform duration-150",
      open ? "rotate-90" : "rotate-0",
    )}
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
  >
    <path d="m9 18 6-6-6-6" />
  </svg>
);

export const OutlineRail = ({
  items,
  scrollContainerRef,
  resolvePct,
  onJump,
  activeId,
  header,
  collapsedFromLevel,
  topOffset = 0,
  panelWidth = 300,
  ariaLabel = "Outline",
}: OutlineRailProps) => {
  const [pctById, setPctById] = useState<Record<string, number>>({});
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
  const panelOpen = hovered || pinned;
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualLockUntil = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
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
    const next: Record<string, number> = {};
    for (const item of items) {
      const pct = resolvePct(item.id, container);
      if (pct !== null) {
        next[item.id] = pct;
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
      if (Date.now() < manualLockUntil.current || container.scrollHeight <= 0) {
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
        manualLockUntil.current = Date.now() + 900;
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
      panelRef.current?.focus();
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
            "flex items-center rounded-md pe-2.5 transition-colors",
            // Leaf rows highlight over the panel's own bg (no occlusion needed).
            !hasChildren && highlighted && "bg-accent",
          )}
          onMouseEnter={() => setHoveredId(node.item.id)}
          onMouseLeave={() => setHoveredId(null)}
          style={
            hasChildren
              ? {
                  position: "sticky",
                  top: node.item.level * ROW_H,
                  zIndex: 40 - node.item.level,
                  // Sticky parents must be fully opaque so scrolled content can't
                  // bleed through; layer the (possibly translucent) accent over a
                  // solid popover fill when highlighted.
                  background: highlighted
                    ? "linear-gradient(var(--color-accent), var(--color-accent)), var(--color-popover)"
                    : "var(--color-popover)",
                }
              : undefined
          }
        >
          {hasChildren ? (
            <button
              aria-expanded={!isCollapsed}
              aria-label={isCollapsed ? "Expand" : "Collapse"}
              className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 items-center justify-center"
              onClick={(event) =>
                toggleCollapse(node.item.id, event.currentTarget.parentElement)
              }
              style={{ marginInlineStart: indent - 4 }}
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
                  className={cn(
                    "flex min-w-0 flex-1 items-baseline gap-1.5 py-1.5 text-start text-[13px] leading-snug",
                    rowTextClass(isActive, hasChildren),
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
            <TooltipPopup>{entryText(node.item)}</TooltipPopup>
          </Tooltip>
          {node.item.meta !== undefined && (
            <span className="text-foreground-placeholder shrink-0 ps-2 text-[11px] tabular-nums">
              {node.item.meta}
            </span>
          )}
        </div>
        {hasChildren && !isCollapsed && (
          <ul className="m-0 list-none p-0">{node.children.map(renderNode)}</ul>
        )}
      </li>
    );
  };

  const visibleTicks = items.filter(
    (item) => item.id in pctById && item.level <= railLevelCap,
  );

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
  const visibleTickIds = new Set(visibleTicks.map((item) => item.id));
  const ghostItem =
    hoveredId !== null && !visibleTickIds.has(hoveredId) && hoveredId in pctById
      ? (items.find((item) => item.id === hoveredId) ?? null)
      : null;

  return (
    <div
      aria-label={ariaLabel}
      className="absolute end-0 z-20 max-lg:hidden"
      role="group"
      style={{ top: topOffset, bottom: 0, width: RAIL_WIDTH }}
    >
      {/* The panel is revealed by hover, which a keyboard cannot perform, and
          it is `inert` until then, so no control inside it can be the way in.
          This one sits outside the panel and stays out of the layout until it
          takes focus, leaving the rail as drawn for pointer readers. */}
      <button
        aria-controls={panelId}
        aria-expanded={panelOpen}
        className="focus-visible:ring-ring bg-popover text-popover-foreground sr-only end-0 top-2 z-30 -translate-x-6 text-xs focus:not-sr-only focus:absolute focus:w-max focus:rounded-md focus:border focus:px-2 focus:py-1 focus-visible:ring-2 focus-visible:outline-none"
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
        {ariaLabel}
      </button>
      <div
        className="relative h-full"
        onMouseEnter={openPanel}
        onMouseLeave={scheduleClose}
        onWheel={(event) => {
          scrollContainerRef.current?.scrollBy(0, event.deltaY);
        }}
      >
        {visibleTicks.map((item) => {
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
                      "absolute end-0 rounded-full transition-[width,height,opacity,background-color] duration-150",
                      isHovered || isActive
                        ? "opacity-100"
                        : "opacity-45 hover:opacity-90",
                    )}
                    onClick={() => jumpTo(item.id)}
                    onMouseEnter={() => setHoveredId(item.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    style={{
                      top: `${pctById[item.id]}%`,
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
        {ghostItem && (
          <span
            aria-hidden
            className="absolute end-0 rounded-full opacity-100"
            style={{
              top: `${pctById[ghostItem.id]}%`,
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

      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- hover-reveal disclosure on a nav landmark; onMouseEnter/Leave drive a supplementary pointer affordance, panel visibility gated by inert/aria-hidden */}
      <nav
        aria-hidden={!panelOpen}
        id={panelId}
        inert={panelOpen ? undefined : true}
        tabIndex={-1}
        className={cn(
          "border-border bg-popover text-popover-foreground absolute overflow-y-auto rounded-xl border pb-2 shadow-lg transition-[opacity,transform] duration-150",
          panelOpen
            ? "translate-x-0 opacity-100"
            : "pointer-events-none translate-x-2 opacity-0",
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
        ref={panelRef}
        style={{
          top: 0,
          insetInlineEnd: RAIL_WIDTH + PANEL_GAP,
          width: panelWidth,
          maxHeight: "calc(100% - 24px)",
        }}
      >
        {header !== undefined && (
          <div className="bg-popover sticky top-0 z-50 border-b p-2">
            {header}
          </div>
        )}
        <ul className="m-0 list-none p-0">{tree.map(renderNode)}</ul>
      </nav>
    </div>
  );
};
