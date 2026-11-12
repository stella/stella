/**
 * Claim qualifiers: caveats beside a verdict that never change it. The
 * server owns which qualifiers a claim carries; this file owns only how each
 * one reads. A silent record is folded into the verdict chip itself ("No
 * coverage · record silent"), so it never shows twice.
 */

import { useTranslations } from "use-intl";

import { ReviewStatusDot } from "@stll/ui/review-severity-dot";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import { StateChip } from "@/features/avt/state-chip";
import type { ClaimState, VerificationClaim } from "@/features/avt/types";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";

type ClaimQualifier = VerificationClaim["qualifiers"][number];
type ClaimQualifierKind = ClaimQualifier["kind"];

type QualifierMeta = {
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  tone: ReviewStatusTone;
};

/** A caveat about the record reads neutral; one about the footing of the
 *  verdict itself (only testimony, no source, a held fact) warns. */
const QUALIFIER_META = {
  "record-silent": {
    labelKey: "avt.qualifiers.recordSilent.label",
    hintKey: "avt.qualifiers.recordSilent.hint",
    tone: "neutral",
  },
  "scope-mismatch": {
    labelKey: "avt.qualifiers.scopeMismatch.label",
    hintKey: "avt.qualifiers.scopeMismatch.hint",
    tone: "neutral",
  },
  "testimony-only": {
    labelKey: "avt.qualifiers.testimonyOnly.label",
    hintKey: "avt.qualifiers.testimonyOnly.hint",
    tone: "warning",
  },
  "unsourced-only": {
    labelKey: "avt.qualifiers.unsourcedOnly.label",
    hintKey: "avt.qualifiers.unsourcedOnly.hint",
    tone: "warning",
  },
  "rests-on-held": {
    labelKey: "avt.qualifiers.restsOnHeld.label",
    hintKey: "avt.qualifiers.restsOnHeld.hint",
    tone: "warning",
  },
} as const satisfies Record<ClaimQualifierKind, QualifierMeta>;

type QualifiedClaim = Pick<VerificationClaim, "qualifiers">;

/** No coverage the record is not expected to give: shown muted, not as a
 *  gap to fill. */
export const isRecordSilent = (
  state: ClaimState,
  { qualifiers }: QualifiedClaim,
): boolean =>
  state === "nocover" &&
  qualifiers.some((qualifier) => qualifier.kind === "record-silent");

/** The qualifiers shown beside the verdict chip, which already says when
 *  the record is silent. */
const chipQualifiers = ({ qualifiers }: QualifiedClaim) =>
  qualifiers.filter((qualifier) => qualifier.kind !== "record-silent");

/** What a qualifier says about this claim: the grader's own reason, or the
 *  rule that set it. */
const useQualifierExplanation = () => {
  const t = useTranslations();
  return (qualifier: ClaimQualifier) =>
    qualifier.explanation ?? t(QUALIFIER_META[qualifier.kind].hintKey);
};

type VerdictChipProps = {
  state: ClaimState;
  claim: QualifiedClaim;
};

/** The verdict chip of one claim, muted when the record is silent. */
export const VerdictChip = ({ state, claim }: VerdictChipProps) => {
  const t = useTranslations();
  if (state === "nocover" && !isRecordSilent(state, claim)) {
    // What a gap is, on hover, so the panel keeps to the next step.
    return (
      <Tooltip>
        <TooltipTrigger render={<span />}>
          <StateChip state={state} />
        </TooltipTrigger>
        <TooltipPopup className="max-w-72">
          {t.rich("avt.claimDetail.basis.gap", {
            strong: (chunks) => <b>{chunks}</b>,
          })}
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (!isRecordSilent(state, claim)) {
    return <StateChip state={state} />;
  }
  return (
    <ReviewStatusBadge
      icon={<ReviewStatusDot tone="neutral" />}
      size="sm"
      tone="neutral"
    >
      {t("avt.states.nocover.silentChip")}
    </ReviewStatusBadge>
  );
};

/** One chip per qualifier, its explanation on hover. */
export const QualifierChips = ({ claim }: { claim: QualifiedClaim }) => {
  const t = useTranslations();
  const explain = useQualifierExplanation();
  return chipQualifiers(claim).map((qualifier) => {
    const meta = QUALIFIER_META[qualifier.kind];
    return (
      <Tooltip key={qualifier.kind}>
        <TooltipTrigger render={<span />}>
          <ReviewStatusBadge
            icon={<ReviewStatusDot tone={meta.tone} />}
            size="sm"
            tone={meta.tone}
          >
            {t(meta.labelKey)}
          </ReviewStatusBadge>
        </TooltipTrigger>
        <TooltipPopup>
          <bdi>{explain(qualifier)}</bdi>
        </TooltipPopup>
      </Tooltip>
    );
  });
};

/**
 * What the grader said about this claim, for the claim detail. A qualifier
 * the system sets by rule says only its rule, which its chip's tooltip
 * already holds, so it gets no line of its own.
 */
export const QualifierNotes = ({ claim }: { claim: QualifiedClaim }) => {
  const t = useTranslations();
  const explain = useQualifierExplanation();
  const graded = claim.qualifiers.filter(
    (qualifier) => qualifier.explanation !== null,
  );
  if (graded.length === 0) {
    return null;
  }
  return (
    <ul aria-label={t("avt.qualifiers.heading")} className="space-y-1.5">
      {graded.map((qualifier) => {
        const meta = QUALIFIER_META[qualifier.kind];
        return (
          <li
            className="text-2xs flex items-start gap-2 leading-relaxed"
            key={qualifier.kind}
          >
            {/* Centred on the first line, however many the note wraps to. */}
            <ReviewStatusDot
              className="mt-[calc(0.5lh-0.1875rem)]"
              tone={meta.tone}
            />
            <span className="min-w-0">
              <span className="text-foreground font-medium">
                {t(meta.labelKey)}
              </span>
              <span className="text-muted-foreground">
                {" · "}
                <bdi>{explain(qualifier)}</bdi>
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
};

/** A claim's qualifiers as one list for its screen-reader announcement;
 *  null when it has none. */
export const useQualifierAnnouncement = () => {
  const t = useTranslations();
  const format = useFormatter();
  return (claim: QualifiedClaim): string | null =>
    claim.qualifiers.length === 0
      ? null
      : format.list(
          claim.qualifiers.map((qualifier) =>
            t(QUALIFIER_META[qualifier.kind].labelKey),
          ),
        );
};
