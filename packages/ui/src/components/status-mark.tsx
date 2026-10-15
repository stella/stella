"use client";

import { cn } from "../lib/utils";

type StatusMarkStatus = "pending" | "running" | "done" | "failed";

type StatusMarkProps = {
  status: StatusMarkStatus;
  /** Accessible name; omit when adjacent text already states the status. */
  label?: string;
  className?: string;
};

// A 16-unit box with a 1.5 stroke: the ring sits inside the box edge.
const RING_RADIUS = 6.25;
const CHECK_PATH = "M5.4 8.3 7.2 10.1 10.6 6.3";
const CROSS_PATH = "M6.1 6.1 9.9 9.9M9.9 6.1 6.1 9.9";

// Every state is a style of the same elements, keyed off `data-status`, so
// a change is a CSS transition: interruptible midway, and absent on first
// paint (a mark that renders settled, as in a reloaded thread, stays still).
const on = {
  active:
    "group-data-[status=running]/status:opacity-100 group-data-[status=done]/status:opacity-50 group-data-[status=failed]/status:opacity-60",
  settled:
    "group-data-[status=done]/status:[stroke-dasharray:100_0] group-data-[status=failed]/status:[stroke-dasharray:100_0]",
};

// The one ring that carries the whole life: eight short dashes while it
// waits, merging into a single arc while it runs, closing to a full circle
// once it settles. A dash pattern eases into the next rather than swapping.
const RING_CLASS = cn(
  "opacity-55 [stroke-dasharray:3.75_8.75]",
  "transition-[stroke-dasharray,opacity] duration-300 ease-in-out motion-reduce:transition-[opacity]",
  "group-data-[status=running]/status:[stroke-dasharray:30_70]",
  on.active,
  on.settled,
  // Without the turn, a running ring still reads as alive.
  "motion-reduce:group-data-[status=running]/status:animate-status-breathe",
);

// The arc turns while running and pauses (never resets) when it stops, so
// it closes from wherever it was instead of jumping back to the top.
const SPIN_CLASS =
  "origin-center [transform-box:view-box] animate-status-spin [animation-play-state:paused] motion-safe:group-data-[status=running]/status:[animation-play-state:running]";

// The check or cross draws in once the ring has closed, and undraws
// quickly when the mark leaves that state.
const markClass = (status: "done" | "failed") =>
  cn(
    "opacity-0 [stroke-dasharray:1_2] [stroke-dashoffset:1.05]",
    "[transition:stroke-dashoffset_150ms_cubic-bezier(0.22,1,0.36,1),opacity_0ms_linear_150ms]",
    status === "done"
      ? "group-data-[status=done]/status:opacity-100 group-data-[status=done]/status:[stroke-dashoffset:0] group-data-[status=done]/status:[transition:stroke-dashoffset_300ms_cubic-bezier(0.22,1,0.36,1)_140ms,opacity_0ms_linear_140ms]"
      : "group-data-[status=failed]/status:opacity-100 group-data-[status=failed]/status:[stroke-dashoffset:0] group-data-[status=failed]/status:[transition:stroke-dashoffset_300ms_cubic-bezier(0.22,1,0.36,1)_140ms,opacity_0ms_linear_140ms]",
    "motion-reduce:[stroke-dashoffset:0] motion-reduce:[transition:opacity_200ms_ease]",
  );

/**
 * One glyph for a unit of work across its life: dashes while it waits, a
 * turning arc while it runs, then a closed ring with a check or a cross
 * drawn in. Monochrome by design: it takes the text colour, and only a
 * failure eases to destructive.
 */
const StatusMark = ({ className, label, status }: StatusMarkProps) => (
  <svg
    className={cn(
      "group/status size-4 shrink-0 transition-[color] duration-200",
      status === "failed" && "text-destructive",
      className,
    )}
    data-slot="status-mark"
    data-status={status}
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.5}
    viewBox="0 0 16 16"
    {...(label === undefined
      ? { "aria-hidden": true }
      : { "aria-label": label, role: "img" })}
  >
    {/* A faint tint inside a settled ring. */}
    <circle
      className="opacity-0 transition-opacity duration-200 group-data-[status=done]/status:opacity-[0.06] group-data-[status=failed]/status:opacity-[0.08]"
      cx="8"
      cy="8"
      fill="currentColor"
      r={RING_RADIUS}
      stroke="none"
    />
    {/* The track the arc runs on, shown only while it runs. */}
    <circle
      className="opacity-0 transition-opacity duration-200 group-data-[status=running]/status:opacity-20"
      cx="8"
      cy="8"
      r={RING_RADIUS}
    />
    <g className={SPIN_CLASS}>
      <circle
        className={RING_CLASS}
        cx="8"
        cy="8"
        pathLength={100}
        r={RING_RADIUS}
        transform="rotate(-90 8 8)"
      />
    </g>
    <path className={markClass("done")} d={CHECK_PATH} pathLength={1} />
    <path className={markClass("failed")} d={CROSS_PATH} pathLength={1} />
  </svg>
);

export { StatusMark };
export type { StatusMarkStatus };
