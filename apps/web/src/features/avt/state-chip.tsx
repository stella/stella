/**
 * AVT verdict, claim-type and confidence chips, shared by the anchor-facts
 * panel, the document view and the claim detail panel. Status pills render
 * through the shared review chrome; the verdict colours for underlines and
 * stat tiles use Stella's semantic tokens.
 */

import type * as React from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  AlertTriangleIcon,
  BanIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  SplitIcon,
  XCircleIcon,
} from "@stll/ui/icons";
import { ListItemStatus } from "@stll/ui/list";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import { TEXT_MARK_TONE_COLOR } from "@stll/ui/text-mark";
import type { TextMarkTone, TextMarkVariant } from "@stll/ui/text-mark";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { TruncatedText } from "@stll/ui/truncated-text";
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
  CONFIDENCE_PHRASE_KEYS,
  STATE_META,
} from "@/features/avt/types";
import { useFormatter } from "@/i18n/formatting-context";

/**
 * Record conflict is not a verdict on the claim but the record disagreeing
 * with itself, so it takes its own hue: the `--option-*` swatch system, set
 * through inline `style` because those are not registered as utilities.
 */
export const RECORD_CONFLICT_VAR = TEXT_MARK_TONE_COLOR["option-purple"];
export const RECORD_CONFLICT_BG_VAR = "var(--option-purple-bg)";
export const RECORD_CONFLICT_FG_VAR = "var(--option-purple-fg)";

type StateColor = {
  icon: typeof CheckCircle2Icon;
  tone: ReviewStatusTone;
  textClass: string;
  textStyle?: React.CSSProperties;
  /** How a claim in this state is marked in the document: the verdict's hue
   *  and line. */
  mark: { variant: TextMarkVariant; tone: TextMarkTone };
  /** Classes the marked words take besides the mark: the verdicts that say
   *  nothing about the claim read muted. Missing coverage is a gap to fill
   *  and reads at full strength, unless the record is silent on the point
   *  (`isRecordSilent`). */
  markTextClass: string;
};

export const STATE_COLOR: Record<ClaimState, StateColor> = {
  supported: {
    icon: CheckCircle2Icon,
    tone: "success",
    textClass: "text-success",
    mark: { variant: "underline", tone: "success" },
    markTextClass: "",
  },
  tension: {
    icon: AlertTriangleIcon,
    tone: "warning",
    textClass: "text-warning",
    mark: { variant: "underline", tone: "warning" },
    markTextClass: "",
  },
  contradicted: {
    icon: XCircleIcon,
    tone: "destructive",
    textClass: "text-destructive-foreground",
    mark: { variant: "underline", tone: "destructive" },
    markTextClass: "",
  },
  nocover: {
    icon: CircleDashedIcon,
    tone: "neutral",
    textClass: "text-muted-foreground",
    mark: { variant: "dotted", tone: "muted" },
    markTextClass: "",
  },
  recordconflict: {
    icon: SplitIcon,
    tone: "highlight",
    textClass: "",
    textStyle: { color: RECORD_CONFLICT_VAR },
    mark: { variant: "wavy", tone: "option-purple" },
    markTextClass: "",
  },
  notverifiable: {
    icon: BanIcon,
    tone: "neutral",
    textClass: "text-muted-foreground",
    mark: { variant: "dotted", tone: "muted" },
    markTextClass: "text-muted-foreground italic",
  },
};

/** A state's hue as a CSS colour, the same one its mark is drawn in. */
export const stateHue = (state: ClaimState): string =>
  TEXT_MARK_TONE_COLOR[STATE_COLOR[state].mark.tone];

/** Small solid-colour square for a stat tile's legend. */
export const StateSwatch = ({ state }: { state: ClaimState }) => (
  <span
    aria-hidden="true"
    className="inline-block size-2 shrink-0 rounded-xs"
    style={{ backgroundColor: stateHue(state) }}
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
  // What the type means is looked up, not read on every claim.
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        <ReviewStatusBadge size="sm" tone="neutral">
          {t(meta.labelKey)}
          {!meta.verifiable && (
            <span className="border-border border-s ps-1.5">
              {t("avt.claimTypes.setAside")}
            </span>
          )}
        </ReviewStatusBadge>
      </TooltipTrigger>
      <TooltipPopup className="max-w-72">{t(meta.hintKey)}</TooltipPopup>
    </Tooltip>
  );
};

export const ConfBadge = ({ level }: { level: FactConfidence | null }) => {
  const t = useTranslations();
  if (level === null) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        <ReviewStatusBadge tone={level === "low" ? "warning" : "neutral"}>
          {t("avt.confidence.interpretation")}{" "}
          <span className="font-semibold">
            {t(CONFIDENCE_LABEL_KEYS[level])}
          </span>
        </ReviewStatusBadge>
      </TooltipTrigger>
      <TooltipPopup>{t("avt.confidence.tooltip")}</TooltipPopup>
    </Tooltip>
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

/** A fact's interpretive confidence as a phrase in a quiet meta line. */
export const ConfidencePhrase = ({ level }: { level: FactConfidence }) => {
  const t = useTranslations();
  return <span>{t(CONFIDENCE_PHRASE_KEYS[level])}</span>;
};

/**
 * A fact held out of scoring in a list row: the status as a dot and label,
 * and why it is held as one clamped quiet line beside it.
 */
export const HeldStatus = ({ note }: { note: string | null }) => {
  const t = useTranslations();
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
      <ListItemStatus tone="warning">
        {t("avt.anchorFacts.heldForReview")}
      </ListItemStatus>
      {note !== null && note !== "" && (
        <TruncatedText className="text-muted-foreground min-w-0" dir="auto">
          {note}
        </TruncatedText>
      )}
    </div>
  );
};

const SAVE_STATE_KEYS = {
  saving: "common.saving",
  saved: "common.saved",
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
