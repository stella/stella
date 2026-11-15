/**
 * A fact's footing as one quiet label: nothing for a document's record,
 * "Testimony" when every source is a person's account, and "Unsourced" with
 * a way to add one when nothing is linked. The server derives the tier; this
 * file owns only how each one reads.
 */

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import type { FactTier } from "@/features/avt/types";
import type { TranslationKey } from "@/i18n/types";

type TierMeta = { labelKey: TranslationKey; hintKey: TranslationKey };

/** A document's record is the expected footing and needs no label. */
const FACT_TIER_META = {
  document: null,
  testimony: {
    labelKey: "avt.factTier.testimony.label",
    hintKey: "avt.factTier.testimony.hint",
  },
  unsourced: {
    labelKey: "avt.factTier.unsourced.label",
    hintKey: "avt.factTier.unsourced.hint",
  },
} as const satisfies Record<FactTier, TierMeta | null>;

/** Whether a tier shows a label at all. */
export const tierIsLabelled = (tier: FactTier): boolean =>
  FACT_TIER_META[tier] !== null;

type FactTierLabelProps = {
  tier: FactTier;
  /** Opens the add-source form for the fact; null when the viewer cannot
   *  add one or the surface offers it elsewhere (a row's menu). */
  onAddSource: (() => void) | null;
};

export const FactTierLabel = ({ tier, onAddSource }: FactTierLabelProps) => {
  const t = useTranslations();
  const meta = FACT_TIER_META[tier];
  if (meta === null) {
    return null;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger render={<span className="text-foreground" />}>
          {t(meta.labelKey)}
        </TooltipTrigger>
        <TooltipPopup className="max-w-72">{t(meta.hintKey)}</TooltipPopup>
      </Tooltip>
      {tier === "unsourced" && onAddSource !== null && (
        <>
          <span aria-hidden="true">·</span>
          {/* A word in the line, not a button beside it: most facts of a
              fresh record have no source, so it must not shout. */}
          <Button onClick={onAddSource} size="inline" variant="muted">
            {t("lists.sources.add")}
          </Button>
        </>
      )}
    </span>
  );
};
