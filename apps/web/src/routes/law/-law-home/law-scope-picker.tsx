import { ListFilterIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { ComposerPicker } from "@stll/ui/composer";

import type { TranslationKey } from "@/i18n/types";
import type { LawScope } from "@/routes/law/-law-home/jurisdictions";

/** What the box searches: both corpora, or one of them. */
export type LawHomeScope = "all" | LawScope;

const SCOPE_LABEL_KEYS = {
  all: "common.all",
  decisions: "common.caseLaw",
  statutes: "statutes.title",
} as const satisfies Record<LawHomeScope, TranslationKey>;

/** Legislation before case law, as the choices read top to bottom. */
const SCOPE_ORDER = ["statutes", "decisions"] as const;

type LawScopePickerProps = {
  /** The corpora this jurisdiction is covered by; a lacking one is not offered. */
  corpora: readonly LawScope[];
  onScopeChange: (scope: LawHomeScope) => void;
  scope: LawHomeScope;
};

/**
 * Which corpus an entry is meant for, as a picker in the status row under
 * the box. The box reads identifiers from both grammars under `all`, so the
 * choice only matters for words and for an identifier both grammars would
 * claim. A jurisdiction the corpus covers on one side only has nothing to
 * choose between, and gets no picker.
 */
export const LawScopePicker = ({
  corpora,
  onScopeChange,
  scope,
}: LawScopePickerProps) => {
  const t = useTranslations();

  if (corpora.length < 2) {
    return null;
  }

  const scopes: LawHomeScope[] = [
    "all",
    ...SCOPE_ORDER.filter((option) => corpora.includes(option)),
  ];

  return (
    <ComposerPicker
      ariaLabel={t("lawHome.scopeLabel")}
      icon={<ListFilterIcon />}
      onChange={onScopeChange}
      options={scopes.map((option) => ({
        label: t(SCOPE_LABEL_KEYS[option]),
        value: option,
      }))}
      value={scope}
    />
  );
};
