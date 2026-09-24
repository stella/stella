/**
 * AVT verdict, claim-type and confidence chips, shared by the anchor-facts
 * panel, the document view and the claim detail panel. Status pills render
 * through the shared review chrome; the verdict colours for underlines and
 * stat tiles use Stella's semantic tokens.
 */

import type * as React from "react";

import {
  AlertTriangleIcon,
  BanIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  PenIcon,
  SplitIcon,
  XCircleIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import { cn } from "@stll/ui/utils";

import type { SaveState } from "@/features/avt/save-state.logic";
import type {
  ClaimState,
  ClaimType,
  FactConfidence,
} from "@/features/avt/types";
import {
  CLAIM_TYPE_META,
  CONFIDENCE_LABEL_KEYS,
  STATE_META,
} from "@/features/avt/types";
import { useFormatter } from "@/i18n/formatting-context";

/**
 * Record conflict is not a verdict on the claim but the record disagreeing
 * with itself, so it takes its own hue: the `--option-*` swatch system, set
 * through inline `style` because those are not registered as utilities.
 */
export const RECORD_CONFLICT_VAR = "var(--option-purple)";
export const RECORD_CONFLICT_BG_VAR = "var(--option-purple-bg)";
export const RECORD_CONFLICT_FG_VAR = "var(--option-purple-fg)";

type StateColor = {
  icon: typeof CheckCircle2Icon;
  tone: ReviewStatusTone;
  textClass: string;
  textStyle?: React.CSSProperties;
  decorationClass: string;
  decorationStyle?: React.CSSProperties;
  swatchStyle: React.CSSProperties;
  /** Background wash for a claim span that matches the active filter. */
  highlightClass: string;
  highlightStyle?: React.CSSProperties;
};

export const STATE_COLOR: Record<ClaimState, StateColor> = {
  supported: {
    icon: CheckCircle2Icon,
    tone: "success",
    textClass: "text-success",
    decorationClass: "decoration-success",
    swatchStyle: { backgroundColor: "var(--success)" },
    highlightClass: "bg-success/15",
  },
  tension: {
    icon: AlertTriangleIcon,
    tone: "warning",
    textClass: "text-warning",
    decorationClass: "decoration-warning",
    swatchStyle: { backgroundColor: "var(--warning)" },
    highlightClass: "bg-warning/15",
  },
  contradicted: {
    icon: XCircleIcon,
    tone: "destructive",
    textClass: "text-destructive-foreground",
    decorationClass: "decoration-destructive",
    swatchStyle: { backgroundColor: "var(--destructive)" },
    highlightClass: "bg-destructive/15",
  },
  nocover: {
    icon: CircleDashedIcon,
    tone: "neutral",
    textClass: "text-muted-foreground",
    decorationClass:
      "text-muted-foreground decoration-muted-foreground decoration-dotted",
    swatchStyle: { backgroundColor: "var(--muted-foreground)" },
    highlightClass: "bg-muted",
  },
  recordconflict: {
    icon: SplitIcon,
    tone: "highlight",
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
    tone: "neutral",
    textClass: "text-muted-foreground",
    decorationClass:
      "text-muted-foreground decoration-muted-foreground decoration-dotted italic",
    swatchStyle: { backgroundColor: "var(--muted-foreground)" },
    highlightClass: "bg-muted",
  },
};

/** Small solid-colour square for a stat tile's legend. */
export const StateSwatch = ({ state }: { state: ClaimState }) => (
  <span
    aria-hidden="true"
    className="inline-block size-2 shrink-0 rounded-xs"
    style={STATE_COLOR[state].swatchStyle}
  />
);

export const StateChip = ({ state }: { state: ClaimState }) => {
  const t = useTranslations();
  const { icon: Icon, tone } = STATE_COLOR[state];
  return (
    <ReviewStatusBadge
      icon={<Icon aria-hidden="true" className="size-3.5" />}
      size="sm"
      tone={tone}
      variant="solid"
    >
      {t(STATE_META[state].chipKey)}
    </ReviewStatusBadge>
  );
};

export const TypeChip = ({ type }: { type: ClaimType }) => {
  const t = useTranslations();
  const meta = CLAIM_TYPE_META[type];
  return (
    <ReviewStatusBadge size="sm" tone="neutral">
      {t(meta.labelKey)}
      {!meta.verifiable && (
        <span className="border-border border-s ps-1.5">
          {t("avt.claimTypes.setAside")}
        </span>
      )}
    </ReviewStatusBadge>
  );
};

export const ConfBadge = ({ level }: { level: FactConfidence | null }) => {
  const t = useTranslations();
  if (level === null) {
    return null;
  }
  return (
    <span title={t("avt.confidence.tooltip")}>
      <ReviewStatusBadge tone={level === "low" ? "warning" : "neutral"}>
        {t("avt.confidence.interpretation")}{" "}
        <span className="font-semibold">{t(CONFIDENCE_LABEL_KEYS[level])}</span>
      </ReviewStatusBadge>
    </span>
  );
};

/** Neutral descriptor of the source carrier (handwritten, scanned). */
export const MediumChip = ({ medium }: { medium: string | null }) => {
  const t = useTranslations();
  if (medium === null) {
    return null;
  }
  return (
    <span title={t("avt.sourceMediumTooltip")}>
      <ReviewStatusBadge
        icon={<PenIcon aria-hidden="true" className="size-3" />}
        tone="neutral"
      >
        {medium}
      </ReviewStatusBadge>
    </span>
  );
};

/** Where the MEANING of the evidence is contested. */
export const InterpNote = ({ note }: { note: string | null }) => {
  if (note === null || note === "") {
    return null;
  }
  return (
    <div className="text-warning-foreground bg-warning/10 border-warning/32 text-2xs flex items-start gap-1.5 rounded-md border px-2.5 py-2 leading-relaxed">
      <CircleAlertIcon
        aria-hidden="true"
        className="text-warning mt-0.5 size-3.5 shrink-0"
      />
      <span dir="auto">{note}</span>
    </div>
  );
};

const SAVE_STATE_KEYS = {
  saving: "avt.save.saving",
  saved: "avt.save.saved",
  failed: "avt.save.failed",
} as const;

/** Saving / saved / not saved, next to whatever an action changed. */
export const SaveIndicator = ({ state }: { state: SaveState }) => {
  const t = useTranslations();
  if (state === "idle") {
    return null;
  }
  return (
    <span
      aria-live="polite"
      className={cn(
        "text-2xs",
        state === "failed"
          ? "text-destructive-foreground"
          : "text-muted-foreground",
      )}
    >
      {t(SAVE_STATE_KEYS[state])}
    </span>
  );
};

export type MatchStepperState = {
  current: number | null;
  total: number;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
};

/**
 * "N/M" position among the active filter's matches, with prev/next, so a
 * reviewer can step through matches without scanning the document by eye.
 */
export const MatchStepper = ({ stepper }: { stepper: MatchStepperState }) => {
  const format = useFormatter();
  const t = useTranslations();
  if (stepper.total === 0) {
    return null;
  }
  return (
    <div className="text-muted-foreground inline-flex items-center gap-1 text-xs tabular-nums">
      {stepper.current === null
        ? t("avt.matches.count", { count: stepper.total })
        : t("avt.matches.position", {
            current: format.number(stepper.current),
            total: format.number(stepper.total),
          })}
      <Button
        aria-label={t("common.previousMatch")}
        disabled={stepper.onPrev === null}
        onClick={stepper.onPrev ?? undefined}
        size="icon-xs"
        variant="ghost"
      >
        <ChevronUpIcon />
      </Button>
      <Button
        aria-label={t("common.nextMatch")}
        disabled={stepper.onNext === null}
        onClick={stepper.onNext ?? undefined}
        size="icon-xs"
        variant="ghost"
      >
        <ChevronDownIcon />
      </Button>
    </div>
  );
};
