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
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "@stll/ui/lib/utils";

export type OutlineItem = {
  id: string;
  label: string;
  /** Nesting depth among included items; drives indent + tick taper. */
  level: number;
  /** Optional trailing annotation in the panel (e.g. a page number). */
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
  topOffset = 0,
  panelWidth = 300,
  ariaLabel = "Outline",
}: OutlineRailProps) => {
  const [pctById, setPctById] = useState<Record<string, number>>({});
  const [derivedActive, setDerivedActive] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualLockUntil = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  // Hold onJump and the scroll-time resolver in refs so the active-tracking
  // scroll listener reads the latest without re-subscribing. recalc instead
  // depends on resolvePct directly, so ticks recompute when the resolver's
  // output changes (e.g. Folio's docSize); React Compiler keeps the adapters'
  // inline resolvers referentially stable between unrelated renders.
  const resolvePctRef = useRef(resolvePct);
  resolvePctRef.current = resolvePct;
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;

  const tree = useMemo(() => buildTree(items), [items]);
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
  recalcRef.current = recalc;

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
    (id: string, level: number, rowEl: HTMLElement | null) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      // Keep the toggled header pinned at its sticky position so it doesn't
      // jump out of view when the content below it grows or shrinks.
      requestAnimationFrame(() => {
        const panel = panelRef.current;
        if (!panel || !rowEl) {
          return;
        }
        const target = panel.getBoundingClientRect().top + level * ROW_H;
        panel.scrollTop += rowEl.getBoundingClientRect().top - target;
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
    const isCollapsed = collapsed.has(node.item.id);
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
                toggleCollapse(
                  node.item.id,
                  node.item.level,
                  event.currentTarget.parentElement,
                )
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
          <button
            className={cn(
              "min-w-0 flex-1 truncate py-1.5 text-start text-[13px] leading-snug",
              rowTextClass(isActive, hasChildren),
            )}
            onClick={() => jumpTo(node.item.id)}
            title={node.item.label}
            type="button"
          >
            {node.item.label}
          </button>
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
  if (items.length < 2) {
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
      style={{ top: topOffset, bottom: 0, width: RAIL_WIDTH }}
    >
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
            <button
              aria-current={isActive ? "true" : undefined}
              aria-label={item.label}
              className={cn(
                "absolute end-0 rounded-full transition-[width,height,opacity,background-color] duration-150",
                isHovered || isActive
                  ? "opacity-100"
                  : "opacity-45 hover:opacity-90",
              )}
              key={item.id}
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
              title={item.label}
              type="button"
            />
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

      <nav
        aria-hidden={!hovered}
        inert={hovered ? undefined : true}
        className={cn(
          "border-border bg-popover text-popover-foreground absolute overflow-y-auto rounded-xl border pb-2 shadow-lg transition-[opacity,transform] duration-150",
          hovered
            ? "translate-x-0 opacity-100"
            : "pointer-events-none translate-x-2 opacity-0",
        )}
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
        <ul className="m-0 list-none p-0">{tree.map(renderNode)}</ul>
      </nav>
    </div>
  );
};
