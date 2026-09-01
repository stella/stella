import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { navigateToCaseDecisionMain } from "@/components/inspector/case-decision-view";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import { useMainCaseLawDecision } from "@/features/case-law/use-main-decision";
import { useFormatter } from "@/i18n/formatting-context";
import {
  createCaseLawDecisionRouteParams,
  normalizeCaseLawLanguageSegment,
} from "@/lib/case-law-route";
import { detached } from "@/lib/detached";

/**
 * The language versions of the decision on the main view. Choosing one
 * navigates to that version's own route, so the URL always names the text on
 * screen. Absent for monolingual decisions and off the decision pages.
 */
export const DecisionLanguageSelect = () => {
  const decision = useMainCaseLawDecision();
  if (decision === undefined || decision.languageAlternates.length < 2) {
    return null;
  }
  return <DecisionLanguageSelectFor decision={decision} />;
};

const DecisionLanguageSelectFor = ({
  decision,
}: {
  decision: PublicCaseLawDecision;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const navigate = useNavigate();
  const { languageAlternates } = decision;
  const currentLanguage = normalizeCaseLawLanguageSegment(decision.language);
  // The list is one version per language, so the version on screen is found
  // by id, or by language when a duplicate row was folded out of the list.
  const current =
    languageAlternates.find((alternate) => alternate.id === decision.id) ??
    languageAlternates.find(
      (alternate) =>
        normalizeCaseLawLanguageSegment(alternate.language) === currentLanguage,
    );

  const onValueChange = (value: string | null) => {
    if (value === null || value === current?.id) {
      return;
    }
    const alternate = languageAlternates.find((entry) => entry.id === value);
    if (alternate === undefined) {
      return;
    }
    const route = createCaseLawDecisionRouteParams({
      caseNumber: alternate.caseNumber,
      country: alternate.country,
      court: alternate.court,
      decisionId: alternate.id,
      language: alternate.language,
      languageAlternates,
      slug: alternate.slug,
    });
    detached(
      navigateToCaseDecisionMain(navigate, {
        caseNumber: alternate.caseNumber,
        country: route.country,
        court: route.court,
        decisionId: alternate.id,
        slug: route.slug,
        ...(route.language === undefined ? {} : { language: route.language }),
      }),
      "case-law.switch-language",
    );
  };

  return (
    <Select onValueChange={onValueChange} value={current?.id ?? decision.id}>
      <SelectTrigger
        aria-label={t("common.language")}
        className="h-8 w-auto text-xs"
        size="sm"
      >
        <SelectValue placeholder={t("common.language")} />
      </SelectTrigger>
      <SelectPopup>
        {languageAlternates.map((alternate) => (
          <SelectItem key={alternate.id} value={alternate.id}>
            {languageLabel(format, alternate.language)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

/** The language's name in the UI locale, or its tag when Intl has none. */
export const languageLabel = (
  format: ReturnType<typeof useFormatter>,
  language: string,
): string => {
  const tag = normalizeCaseLawLanguageSegment(language) ?? language;
  return format.displayName(tag, { type: "language" }) ?? tag.toUpperCase();
};
