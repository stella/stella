import { useTranslations } from "use-intl";

import { COMPOSER_PICKER_TRIGGER_CLASS } from "@stll/ui/composer";
import { cn } from "@stll/ui/utils";

import type { TranslationKey } from "@/i18n/types";
import type { LawScope } from "@/routes/law/-law-home/jurisdictions";

/** What the box searches: both corpora, or one of them. */
export type LawHomeScope = "all" | LawScope;

const SCOPE_LABEL_KEYS = {
  all: "common.all",
  decisions: "common.caseLaw",
  statutes: "statutes.title",
} as const satisfies Record<LawHomeScope, TranslationKey>;

/** Legislation before case law, as the tabs read left to right. */
const SCOPE_ORDER = ["statutes", "decisions"] as const;

type LawScopeTabsProps = {
  /** The corpora this jurisdiction is covered by; a lacking one is not offered. */
  corpora: readonly LawScope[];
  onScopeChange: (scope: LawHomeScope) => void;
  scope: LawHomeScope;
};

/**
 * Which corpus an entry is meant for, as pickers in the status row under
 * the box. The box reads identifiers from both grammars under `all`, so the
 * choice only matters for words and for an identifier both grammars would
 * claim. A jurisdiction the corpus covers on one side only has nothing to
 * choose between, and gets no pickers.
 */
export const LawScopeTabs = ({
  corpora,
  onScopeChange,
  scope,
}: LawScopeTabsProps) => {
  const t = useTranslations();

  if (corpora.length < 2) {
    return null;
  }

  const scopes: LawHomeScope[] = [
    "all",
    ...SCOPE_ORDER.filter((option) => corpora.includes(option)),
  ];

  return (
    <div
      aria-label={t("lawHome.scopeLabel")}
      className="flex items-center gap-0.5"
      role="group"
    >
      {scopes.map((option) => {
        const isActive = option === scope;
        return (
          <button
            aria-pressed={isActive}
            className={cn(
              COMPOSER_PICKER_TRIGGER_CLASS,
              isActive && "text-foreground bg-accent",
            )}
            key={option}
            onClick={() => onScopeChange(option)}
            type="button"
          >
            {t(SCOPE_LABEL_KEYS[option])}
          </button>
        );
      })}
    </div>
  );
};
