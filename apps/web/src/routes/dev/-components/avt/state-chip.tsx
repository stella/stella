/**
 * AVT — shared verdict/type/confidence chips, reused across the
 * anchor-facts panel, the document view, and the detail panel. Ported
 * from the prototype's `app/ui.jsx` (StateChip/TypeChip/ConfBadge/
 * MediumChip/InterpNote) onto Stella's real semantic color tokens
 * instead of bespoke CSS variables.
 */

import type * as React from "react";

import {
  AlertTriangleIcon,
  BanIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleDashedIcon,
  PenIcon,
  ScaleIcon,
  SplitIcon,
  XCircleIcon,
} from "lucide-react";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import {
  CLAIM_TYPE_META,
  STATE_META,
  type ClaimState,
  type ClaimType,
  type ConfidenceLevel,
} from "@/routes/dev/-components/avt/types";

/**
 * Record conflict has no equivalent in Stella's semantic token triad
 * (success/warning/destructive) — it isn't a claim verdict, it's the
 * record disagreeing with itself, so it needs its own hue. Stella's
 * `--primary` token is a near-black ink color (used for primary
 * buttons), not a distinct accent, so it can't serve here. Stella's
 * actual mechanism for an extra category color is the `--option-*`
 * swatch system (see packages/ui/src/styles/globals.css) — the same
 * one `cell-metadata-flags.tsx` uses via inline `style`, since these
 * aren't registered as Tailwind `@theme` utility classes.
 */
export const RECORD_CONFLICT_VAR = "var(--option-purple)";
export const RECORD_CONFLICT_BG_VAR = "var(--option-purple-bg)";
export const RECORD_CONFLICT_FG_VAR = "var(--option-purple-fg)";

type StateColor = {
  icon: typeof CheckCircle2Icon;
  chipClass: string;
  chipStyle?: React.CSSProperties;
  textClass: string;
  textStyle?: React.CSSProperties;
  decorationClass: string;
  decorationStyle?: React.CSSProperties;
  swatchStyle: React.CSSProperties;
  /** Background wash for a claim span that matches the active filter — makes it pop against dimmed non-matches. */
  highlightClass: string;
  highlightStyle?: React.CSSProperties;
};

const STATE_COLOR: Record<ClaimState, StateColor> = {
  supported: {
    icon: CheckCircle2Icon,
    chipClass: "text-success border-success/32 bg-success/10",
    textClass: "text-success",
    decorationClass: "decoration-success",
    swatchStyle: { backgroundColor: "var(--success)" },
    highlightClass: "bg-success/15",
  },
  tension: {
    icon: AlertTriangleIcon,
    chipClass: "text-warning border-warning/32 bg-warning/10",
    textClass: "text-warning",
    decorationClass: "decoration-warning",
    swatchStyle: { backgroundColor: "var(--warning)" },
    highlightClass: "bg-warning/15",
  },
  contradicted: {
    icon: XCircleIcon,
    chipClass:
      "text-destructive-foreground border-destructive/32 bg-destructive/10",
    textClass: "text-destructive-foreground",
    decorationClass: "decoration-destructive",
    swatchStyle: { backgroundColor: "var(--destructive)" },
    highlightClass: "bg-destructive/15",
  },
  nocover: {
    icon: CircleDashedIcon,
    chipClass: "text-muted-foreground border-border bg-muted",
    textClass: "text-muted-foreground",
    decorationClass:
      "text-muted-foreground decoration-muted-foreground decoration-dotted",
    swatchStyle: { backgroundColor: "var(--muted-foreground)" },
    highlightClass: "bg-muted",
  },
  recordconflict: {
    icon: SplitIcon,
    chipClass: "border-transparent",
    chipStyle: {
      color: RECORD_CONFLICT_FG_VAR,
      backgroundColor: RECORD_CONFLICT_BG_VAR,
      borderColor: RECORD_CONFLICT_VAR,
    },
    textClass: "",
    textStyle: { color: RECORD_CONFLICT_VAR },
    decorationClass: "decoration-wavy",
    decorationStyle: { textDecorationColor: RECORD_CONFLICT_VAR },
    swatchStyle: { backgroundColor: RECORD_CONFLICT_VAR },
    highlightClass: "",
    highlightStyle: { backgroundColor: RECORD_CONFLICT_BG_VAR },
  },
  notverifiable: {
    icon: BanIcon,
    chipClass: "text-muted-foreground border-border bg-muted italic",
    textClass: "text-muted-foreground",
    decorationClass:
      "text-muted-foreground decoration-muted-foreground decoration-dotted italic",
    swatchStyle: { backgroundColor: "var(--muted-foreground)" },
    highlightClass: "bg-muted",
  },
};

/**
 * Full per-state color definition (text/chip/decoration classes plus
 * the record-conflict inline-style overrides). Exported directly so
 * consumers pull exactly the field they need — e.g.
 * `STATE_COLOR[state].textClass` — rather than deriving separate maps.
 */
export { STATE_COLOR };

/** Small solid-color square — matches the prototype's `.stat .k .sw` legend swatch. */
export function StateSwatch({ state }: { state: ClaimState }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2 shrink-0 rounded-[2px]"
      style={STATE_COLOR[state].swatchStyle}
    />
  );
}

export function StateChip({ state }: { state: ClaimState }) {
  const color = STATE_COLOR[state];
  const Icon = color.icon;
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold",
        color.chipClass,
      )}
      style={color.chipStyle}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {STATE_META[state].chip}
    </span>
  );
}

export function TypeChip({ type }: { type: ClaimType }) {
  const meta = CLAIM_TYPE_META[type];
  return (
    <span className="bg-muted text-foreground border-border inline-flex h-6 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold">
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          type === "fact" ? "bg-primary" : "bg-warning",
        )}
      />
      {meta.label}
      {!meta.verifiable && (
        <span className="border-border text-muted-foreground border-s ps-1.5 text-[11px] font-medium normal-case">
          set aside
        </span>
      )}
    </span>
  );
}

export function ConfBadge({ level }: { level: ConfidenceLevel }) {
  const low = level === "Low";
  return (
    <span
      className={cn(
        "border-border bg-muted text-muted-foreground inline-flex h-5.5 items-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold",
        low && "text-warning border-warning/32 bg-warning/10",
      )}
      title="Interpretive confidence — how unambiguous this evidence's meaning is. Independent of the source medium (handwriting, scan, etc.)."
    >
      Interpretation <span className="font-bold">{level}</span>
    </span>
  );
}

/** Neutral descriptor of the source carrier (handwritten / scanned). Informational only. */
export function MediumChip({ medium }: { medium: string | undefined }) {
  if (!medium) {
    return null;
  }
  return (
    <span
      className="bg-muted text-muted-foreground border-border inline-flex h-5.5 items-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold whitespace-nowrap"
      title="Source medium — a neutral descriptor. It does not lower confidence on its own."
    >
      <PenIcon aria-hidden="true" className="size-3" />
      {medium}
    </span>
  );
}

/** Substantive interpretation caveat — shown where the MEANING of the evidence is contested. */
export function InterpNote({ note }: { note: string | undefined }) {
  if (!note) {
    return null;
  }
  return (
    <div className="text-warning-foreground bg-warning/10 border-warning/32 flex items-start gap-1.5 rounded-md border px-2.5 py-2 text-[11.5px] leading-relaxed">
      <ScaleIcon
        aria-hidden="true"
        className="text-warning mt-0.5 size-3.5 shrink-0"
      />
      <span>{note}</span>
    </div>
  );
}

export type MatchStepperState = {
  current: number | null;
  total: number;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
};

/**
 * "N/M" position among the active filter's matches, with prev/next —
 * lets a reviewer step through matches without scanning the document
 * by eye. Shown next to the current claim in the document (sticky, so
 * it doesn't fight inline text flow) and mirrored in the detail panel,
 * since a reviewer stepping through matches doesn't always care about
 * any one claim's detail. Lives here (not in verification-view.tsx)
 * so both it and claim-detail-panel.tsx can import it without a cycle.
 */
export function MatchStepper({ stepper }: { stepper: MatchStepperState }) {
  if (stepper.total === 0) {
    return null;
  }
  return (
    <div className="text-muted-foreground inline-flex items-center gap-1 text-xs tabular-nums">
      {stepper.current !== null
        ? `${stepper.current}/${stepper.total}`
        : `${stepper.total} matches`}
      <Button
        aria-label="Previous match"
        disabled={!stepper.onPrev}
        onClick={stepper.onPrev ?? undefined}
        size="icon-xs"
        variant="ghost"
      >
        <ChevronUpIcon />
      </Button>
      <Button
        aria-label="Next match"
        disabled={!stepper.onNext}
        onClick={stepper.onNext ?? undefined}
        size="icon-xs"
        variant="ghost"
      >
        <ChevronDownIcon />
      </Button>
    </div>
  );
}
