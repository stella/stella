import { type PropsWithChildren, useId, useState } from "react";

import { panic } from "better-result";
import { ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { DirectionalIcon } from "@stll/ui/directional-icon";
import { cn } from "@stll/ui/utils";

import { ReviewAlignedPair } from "@/components/ai-suggestions/review-aligned-pair";
import type {
  DeltaCitation,
  ReviewDelta,
} from "@/components/ai-suggestions/review-delta";
import { ReviewPresenceMatrix } from "@/components/ai-suggestions/review-presence-matrix";
import { ReviewTermTable } from "@/components/ai-suggestions/review-term-row";
import { useFormatter } from "@/i18n/formatting-context";

export type ReviewDeltaSide = {
  label: string;
  passages: readonly DeltaCitation[];
  /** What the side says when it quotes nothing; see `ReviewAlignedPairSide`. */
  emptyLabel?: string | undefined;
};

export type ReviewDeltaViewProps = {
  delta: ReviewDelta;
  target: ReviewDeltaSide;
  standard: ReviewDeltaSide;
  onShowInDocument?: ((blockId: string) => void) | undefined;
  /** Opens a standard passage in the reference it was quoted from. */
  onShowStandardPassage?: ((blockId: string) => void) | undefined;
  /** Names the reference the standard was read from, e.g.
   *  `Standard (Master NDA)`. Falls back to `standard.label`. */
  standardLabel?: string | undefined;
};

/**
 * A graded finding, read top down: what the delta claims, then the passages
 * it claims it about. The summary shape is the delta's own — a term row for a
 * parameter, a presence matrix for an enumeration — and the aligned pair
 * always follows it, because a reviewer who cannot see the wording cannot
 * check the claim.
 */
export const ReviewDeltaView = ({
  delta,
  target,
  standard,
  onShowInDocument,
  onShowStandardPassage,
  standardLabel,
}: ReviewDeltaViewProps) => {
  const standardHeading = standardLabel ?? standard.label;
  // A parameter delta names the exact phrase that differs on each side, so
  // the pair can mark that phrase rather than every figure in the passage.
  const pair = (
    <ReviewAlignedPair
      delta={delta.kind === "parameter" ? delta : undefined}
      onShowInDocument={onShowInDocument}
      onShowStandardPassage={onShowStandardPassage}
      standard={standard}
      standardLabel={standardHeading}
      target={target}
    />
  );

  const passageCount = target.passages.length + standard.passages.length;

  switch (delta.kind) {
    case "parameter":
      return (
        <div className="space-y-2">
          <ReviewTermTable
            delta={delta}
            onShowInDocument={onShowInDocument}
            standardLabel={standardHeading}
            targetLabel={target.label}
          />
          <PassagesDisclosure count={passageCount}>{pair}</PassagesDisclosure>
        </div>
      );
    case "enumeration":
    case "presence":
      return (
        <div className="space-y-2">
          <ReviewPresenceMatrix
            delta={delta}
            onShowInDocument={onShowInDocument}
            standardLabel={standardHeading}
            targetLabel={target.label}
          />
          <PassagesDisclosure count={passageCount}>{pair}</PassagesDisclosure>
        </div>
      );
    case "language":
      return pair;
    default:
      delta satisfies never;
      return panic(`Unhandled delta: ${String(delta)}`);
  }
};

/**
 * The passages behind a summary, one click away. When the delta already
 * states the difference as a term or a matrix, the quoted prose is evidence
 * a reviewer opens to check it, not the first thing to read; a language
 * delta has no summary, so its pair stays open.
 */
export const PassagesDisclosure = ({
  count,
  children,
}: PropsWithChildren<{ count: number }>) => {
  const t = useTranslations();
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div>
      {/* The same typography as the card's other disclosure ("Why"): one
          size, sentence case, a chevron; two toggles in one card must read as
          the same control. */}
      <button
        aria-controls={panelId}
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground -mx-1 flex min-h-8 items-center gap-1 px-1 text-xs"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <DirectionalIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
          flip={!open}
          icon={ChevronRightIcon}
        />
        {t("inspector.review.passagesToggle")}
        <span className="text-foreground-ghost tabular-nums">
          {format.number(count)}
        </span>
      </button>
      {open && (
        <div className="mt-1" id={panelId}>
          {children}
        </div>
      )}
    </div>
  );
};
