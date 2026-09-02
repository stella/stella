import { useEffect, useRef, useState } from "react";

import { ChevronDownIcon } from "lucide-react";

import { Button } from "../components/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/tooltip";
import { cn } from "../lib/utils";
import { TOOLBAR_ROW_HEIGHT } from "./layout-tokens";

export type InspectorFacetBarProps<F extends string> = {
  facet: F;
  facets: readonly F[];
  /** Display label per facet. */
  labels: Record<F, string>;
  /**
   * Facets rendered but not interactive — visible so users can find
   * them, but clicking does nothing (e.g. an AI-suggestions chip
   * before any proposals exist).
   */
  disabledFacets?: ReadonlySet<F> | undefined;
  /**
   * Bumping this replays a one-shot attention pulse on the active
   * chip (e.g. after a background action changes it). Undefined or
   * unchanged: no pulse.
   */
  pulseSeq?: number | undefined;
  /**
   * Suffix appended to the active facet's label, e.g. `"v1"` →
   * "Preview · v1". Hidden on inactive chips so the row stays
   * scannable.
   */
  activeBadge?: string | undefined;
  /** Accessible name for the overflow chevron trigger. The host owns
   * copy/translation; this only wires the affordance. */
  overflowMenuLabel: string;
  onChange: (next: F) => void;
};

/**
 * Inspector subtab row: a single line of pill chips at toolbar-row
 * height. Presentational and facet-agnostic — every inspector tab
 * type (file-viewer facets, template-studio fields/clauses/history)
 * drives it with its own facet union + labels so the row reads
 * identically across the inspector.
 *
 * Labels are never truncated: when the row is too narrow for every
 * chip, the ones that don't fit collapse into a trailing chevron
 * (`˅`) dropdown. The active facet is always pinned visible so the
 * current tab stays readable rather than hiding inside the menu.
 */
export const InspectorFacetBar = <F extends string>({
  facet,
  facets,
  labels,
  disabledFacets,
  pulseSeq,
  activeBadge,
  overflowMenuLabel,
  onChange,
}: InspectorFacetBarProps<F>) => {
  const lastPulseSeq = useRef<number | undefined>(pulseSeq);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(facets.length);

  // Bumping `pulseSeq` flashes the active chip once — a background action
  // (e.g. a version landing) changed which facet is active, and the flash
  // is the confirmation. An imperative Web Animations API call on the
  // active chip's own element, exactly like the rail's `flashTabElement`,
  // rather than a toggled `animate-pulse` utility class.
  useEffect(() => {
    if (pulseSeq === undefined || pulseSeq === lastPulseSeq.current) {
      return;
    }
    lastPulseSeq.current = pulseSeq;
    const activeChip = containerRef.current?.querySelector(
      "[data-facet-chip-active]",
    );
    if (activeChip instanceof HTMLElement) {
      flashFacetChip(activeChip);
    }
  }, [pulseSeq]);

  // Measure the full-width chips off-screen and recompute how many fit
  // (reserving room for the overflow trigger) whenever the row resizes
  // or the labels change. Off-screen measurement keeps the widths stable
  // regardless of how many chips the visible row is currently showing,
  // so there's no measure/collapse feedback loop.
  useEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) {
      return undefined;
    }

    const recompute = () => {
      const style = getComputedStyle(container);
      // `|| 0`: computed padding can be "" on a detached node and columnGap is
      // "normal" when no gap is set — both make parseFloat return NaN.
      const padX =
        (Number.parseFloat(style.paddingInlineStart) || 0) +
        (Number.parseFloat(style.paddingInlineEnd) || 0);
      const gap = Number.parseFloat(style.columnGap) || 0;
      const available = container.clientWidth - padX;

      const cells = [...measure.children];
      const triggerWidth = cells.at(-1)?.getBoundingClientRect().width ?? 0;
      const chipWidths = cells
        .slice(0, facets.length)
        .map((cell) => cell.getBoundingClientRect().width);

      const total = chipWidths.reduce(
        (sum, width, index) => sum + width + (index > 0 ? gap : 0),
        0,
      );
      if (total <= available) {
        setVisibleCount(facets.length);
        return;
      }

      // Overflowing: greedily keep chips that fit alongside the trigger.
      let used = 0;
      let count = 0;
      for (const width of chipWidths) {
        const add = width + (count > 0 ? gap : 0);
        if (used + add + gap + triggerWidth > available) {
          break;
        }
        used += add;
        count += 1;
      }

      // The active facet is pinned into the visible set at render even when it
      // sits past the greedy fit; it can be wider than the chip it displaces,
      // so recount reserving the active chip's own width to keep it (and the
      // trigger) from clipping.
      const activeIndex = facets.indexOf(facet);
      if (activeIndex >= count) {
        const activeWidth = chipWidths[activeIndex] ?? 0;
        used = activeWidth;
        count = 0;
        for (const [i, width] of chipWidths.entries()) {
          if (i === activeIndex) {
            continue;
          }
          const add = width + gap;
          if (used + add + gap + triggerWidth > available) {
            break;
          }
          used += add;
          count += 1;
        }
        setVisibleCount(count + 1);
        return;
      }

      setVisibleCount(count);
    };

    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    observer.observe(measure);
    recompute();
    return () => observer.disconnect();
  }, [facets, facet]);

  const overflowing = visibleCount < facets.length;
  const activeIndex = facets.indexOf(facet);

  let visibleFacets: F[];
  let overflowFacets: F[];
  if (!overflowing) {
    visibleFacets = [...facets];
    overflowFacets = [];
  } else if (activeIndex < visibleCount) {
    visibleFacets = facets.slice(0, visibleCount);
    overflowFacets = facets.slice(visibleCount);
  } else {
    // The active facet would overflow: pin it into the last visible slot
    // so the current tab is always readable, and overflow the rest in
    // their original order.
    const head = facets.slice(0, Math.max(visibleCount - 1, 0));
    visibleFacets = [...head, facet];
    overflowFacets = facets.filter((value) => !visibleFacets.includes(value));
  }

  return (
    <div
      className={cn(
        "bg-background/85 supports-[backdrop-filter]:bg-background/65 sticky top-0 z-10 flex shrink-0 items-center gap-0.5 overflow-hidden border-b px-1.5 backdrop-blur",
        TOOLBAR_ROW_HEIGHT,
      )}
      ref={containerRef}
    >
      {visibleFacets.map((value) => (
        <FacetChip
          activeBadge={activeBadge}
          disabled={disabledFacets?.has(value) ?? false}
          isActive={value === facet}
          key={value}
          label={labels[value]}
          onSelect={() => onChange(value)}
        />
      ))}

      {overflowing && (
        <Menu>
          <MenuTrigger
            aria-label={overflowMenuLabel}
            // Pinned to the inline-end (far right in LTR, far left in RTL)
            // via `ms-auto`, set apart from the last chip rather than
            // crammed beside it. The outline variant reads as a real
            // button, not a bare chevron.
            className="ms-auto"
            render={<Button size="icon-sm" type="button" variant="outline" />}
          >
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom">
            {overflowFacets.map((value) => (
              <MenuItem
                disabled={disabledFacets?.has(value) ?? false}
                key={value}
                onClick={() => onChange(value)}
              >
                {labels[value]}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      )}

      {/* Off-screen full-width copy of every chip (plus the trigger) used
          only to measure natural widths; never visible or interactive. */}
      <div
        aria-hidden="true"
        className="pointer-events-none invisible absolute flex w-max items-center gap-0.5"
        ref={measureRef}
      >
        {facets.map((value) => (
          <span className={cn(CHIP_CLASS, INACTIVE_CHIP_CLASS)} key={value}>
            {labels[value]}
          </span>
        ))}
        {/* Mirrors the overflow trigger's square footprint (Button
            `size="icon-sm"`) so the fit calculation reserves the right
            amount of room for it. */}
        <span className="size-8 shrink-0 rounded-lg border sm:size-7" />
      </div>
    </div>
  );
};

/** One-shot attention flash: a ring that appears with a couple of opacity
 * dips over 1.4s, then fades — the same imperative Web Animations API
 * technique the rail's `flashTabElement` uses, so a single call finishes on
 * its own without any pulsing state to track or clean up. */
const flashFacetChip = (el: HTMLElement) => {
  const ring = "0 0 0 2px var(--color-foreground-disabled)";
  el.animate(
    [
      { boxShadow: ring, opacity: 1 },
      { boxShadow: ring, opacity: 0.5 },
      { boxShadow: ring, opacity: 1 },
      { boxShadow: ring, opacity: 0.5 },
      { boxShadow: "0 0 0 2px transparent", opacity: 1 },
    ],
    { duration: 1400, easing: "ease-in-out" },
  );
};

const CHIP_CLASS =
  "shrink-0 rounded-md px-1.5 py-1 text-xs font-medium whitespace-nowrap transition-colors";
const INACTIVE_CHIP_CLASS =
  "text-muted-foreground hover:bg-muted hover:text-foreground";

type FacetChipProps = {
  label: string;
  isActive: boolean;
  disabled: boolean;
  activeBadge: string | undefined;
  onSelect: () => void;
};

const FacetChip = ({
  label,
  isActive,
  disabled,
  activeBadge,
  onSelect,
}: FacetChipProps) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <button
          className={cn(
            CHIP_CLASS,
            isActive ? "bg-foreground text-background" : INACTIVE_CHIP_CLASS,
            disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
          )}
          data-facet-chip-active={isActive ? "" : undefined}
          disabled={disabled}
          onClick={onSelect}
          type="button"
        />
      }
    >
      {label}
    </TooltipTrigger>
    <TooltipPopup>
      {isActive && activeBadge !== undefined
        ? `${label} · ${activeBadge}`
        : label}
    </TooltipPopup>
  </Tooltip>
);
