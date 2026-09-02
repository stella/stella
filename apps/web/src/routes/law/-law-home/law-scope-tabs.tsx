import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
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
 * Which corpus an entry is meant for. The box reads identifiers from both
 * grammars under `all`, so the choice only matters for words and for an
 * identifier both grammars would claim. A jurisdiction the corpus covers on
 * one side only has nothing to choose between, and gets no tabs.
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
      className="border-border/70 bg-muted/30 inline-flex items-center gap-0.5 rounded-md border p-0.5"
      role="group"
    >
      {scopes.map((option) => {
        const isActive = option === scope;
        return (
          <Button
            aria-pressed={isActive}
            className={cn(
              "text-muted-foreground h-7 rounded-[4px] px-2.5 text-xs",
              isActive &&
                "bg-background text-foreground ring-border/80 hover:bg-background hover:text-foreground shadow-xs ring-1",
            )}
            key={option}
            onClick={() => onScopeChange(option)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t(SCOPE_LABEL_KEYS[option])}
          </Button>
        );
      })}
    </div>
  );
};
