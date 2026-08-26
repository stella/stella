/**
 * How a reviewer flag looks and reads, once, for every surface that shows one.
 *
 * The vocabulary itself lives in `@stll/api-contract`; this is the presentation
 * over it. The map is total by construction, so a flag added to the contract
 * fails typecheck here until it has an icon, a colour and a label rather than
 * rendering as a blank in a cell corner or a finding card.
 */

import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2Icon,
  CheckIcon,
  HelpCircleIcon,
  MessageSquareWarningIcon,
  ShieldAlertIcon,
  StarIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { REVIEW_FLAGS } from "@stll/api-contract";
import type { ReviewFlag } from "@stll/api-contract";
import { MenuItem } from "@stll/ui/menu";

import type { TranslationKey } from "@/i18n/types";

type ReviewFlagPresentation = {
  icon: LucideIcon;
  /** Semantic option token, used for the glyph and for the cell tint. */
  color: string;
  background: string;
  labelKey: TranslationKey;
};

export const REVIEW_FLAG_PRESENTATION = {
  "needs-review": {
    icon: HelpCircleIcon,
    color: "var(--option-amber)",
    background: "var(--option-amber-bg)",
    labelKey: "workspaces.table.flags.needsReview",
  },
  important: {
    icon: StarIcon,
    color: "var(--option-blue)",
    background: "var(--option-blue-bg)",
    labelKey: "workspaces.table.flags.important",
  },
  "follow-up": {
    icon: MessageSquareWarningIcon,
    color: "var(--option-violet)",
    background: "var(--option-violet-bg)",
    labelKey: "workspaces.table.flags.followUp",
  },
  contradiction: {
    icon: ShieldAlertIcon,
    color: "var(--option-red)",
    background: "var(--option-red-bg)",
    labelKey: "workspaces.table.flags.contradiction",
  },
  verified: {
    icon: CheckCircle2Icon,
    color: "var(--option-emerald)",
    background: "var(--option-emerald-bg)",
    labelKey: "workspaces.table.flags.verified",
  },
} as const satisfies Record<ReviewFlag, ReviewFlagPresentation>;

export const useReviewFlagLabel = () => {
  const t = useTranslations();
  return (flag: ReviewFlag) => t(REVIEW_FLAG_PRESENTATION[flag].labelKey);
};

type ReviewFlagMenuItemsProps = {
  active: readonly ReviewFlag[];
  disabled?: boolean;
  onToggle: (flag: ReviewFlag) => void;
};

/**
 * The flag list as menu rows: the whole vocabulary, ticked where it is set.
 *
 * Presentational on purpose — the cell keeps its optimistic override store and
 * the finding card keeps its mutation, and both hand this the same two things:
 * what is on, and what to do when a row is clicked.
 */
export const ReviewFlagMenuItems = ({
  active,
  disabled = false,
  onToggle,
}: ReviewFlagMenuItemsProps) => {
  const t = useTranslations();
  return (
    <>
      {REVIEW_FLAGS.map((flag) => {
        const { color, icon: Icon, labelKey } = REVIEW_FLAG_PRESENTATION[flag];
        return (
          <MenuItem
            className="min-h-7 py-0.5 text-sm"
            closeOnClick={false}
            disabled={disabled}
            key={flag}
            onClick={() => onToggle(flag)}
          >
            <Icon className="size-3.5 shrink-0 opacity-75" style={{ color }} />
            <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
            {active.includes(flag) && (
              <CheckIcon className="text-muted-foreground ms-3 size-3.5 shrink-0" />
            )}
          </MenuItem>
        );
      })}
    </>
  );
};

/** The flags an item carries, as the same glyphs the menu offers. Renders
 *  nothing when there are none, so a caller needs no emptiness branch. */
export const ReviewFlagGlyphs = ({
  className,
  flags,
}: {
  className?: string;
  flags: readonly ReviewFlag[];
}) => {
  const getFlagLabel = useReviewFlagLabel();
  if (flags.length === 0) {
    return null;
  }
  return (
    <span className={className}>
      {flags.map((flag) => {
        const { color, icon: Icon } = REVIEW_FLAG_PRESENTATION[flag];
        return (
          <Icon
            aria-label={getFlagLabel(flag)}
            className="size-3.5 shrink-0"
            key={flag}
            role="img"
            style={{ color }}
          />
        );
      })}
    </span>
  );
};
