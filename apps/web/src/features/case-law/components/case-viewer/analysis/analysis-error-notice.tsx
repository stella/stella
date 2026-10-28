import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { CASE_LAW_ANALYSIS_LANGUAGES } from "@stll/api-contract";
import { createCaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";
import { Button } from "@stll/ui/button";
import { SparklesIcon } from "@stll/ui/icons";

import { ProviderDiagnosticMessage } from "@/components/provider-diagnostic-message";
import {
  type AnalysisErrorMessage,
  analysisErrorMessage,
  analysisLanguageVersion,
  analysisRetryAt,
} from "@/features/case-law/components/case-viewer/analysis/analysis-error.logic";
import { analysisRetryOf } from "@/features/case-law/components/case-viewer/analysis/use-decision-analysis";
import { decisionLinkElement } from "@/features/case-law/components/decision-cells";
import { languageLabel } from "@/features/case-law/components/decision-language-select";
import type { PublicDecisionLanguageAlternate } from "@/features/case-law/public-decision";
import type { AnalysisError } from "@/features/case-law/queries/decision-analysis";
import { useCaseLawReadingLanguages } from "@/features/case-law/reading-languages";
import { useTimePassed } from "@/hooks/use-time-passed";
import { useFormatter } from "@/i18n/formatting-context";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

const NO_LANGUAGE_VERSIONS: readonly PublicDecisionLanguageAlternate[] = [];

const useAnalysisErrorText = (message: AnalysisErrorMessage): string => {
  const t = useTranslations();
  const format = useFormatter();
  switch (message.kind) {
    case "keyed":
      return t(message.key, message.values);
    case "generic":
      return t("errors.api.server");
    case "unavailable":
      return t(message.key, {
        languages: format.list(
          CASE_LAW_ANALYSIS_LANGUAGES.map((language) =>
            languageLabel(format, language),
          ),
        ),
      });
    default:
      message satisfies never;
      return panic("Unhandled analysis error message");
  }
};

/**
 * Why the analysis column holds no analysis, and the way to ask again when
 * asking again can help. A failed run names whose key it used, so a reader
 * on their organization's own key knows where the fault sits; one whose
 * provider named a time to retry after says when, and offers the retry only
 * from then on.
 */
export const AnalysisErrorNotice = ({
  error,
  languageVersions = NO_LANGUAGE_VERSIONS,
  onRetry,
}: {
  error: AnalysisError;
  /**
   * Every language version of the decision, so a version in a language no
   * analysis is written for can offer one that has it.
   */
  languageVersions?: readonly PublicDecisionLanguageAlternate[] | undefined;
  onRetry: () => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const readingLanguages = useCaseLawReadingLanguages();
  const text = useAnalysisErrorText(analysisErrorMessage(error));
  const analysableVersion =
    error.kind === "unavailable" && error.code === "language_unsupported"
      ? analysisLanguageVersion(languageVersions, readingLanguages)
      : null;
  const retryAt = analysisRetryAt(error);
  const retryTimePassed = useTimePassed(retryAt);
  return (
    <div
      className="bg-background/75 supports-[backdrop-filter]:bg-background/55 mx-2 mt-8 flex flex-col items-center gap-2 rounded-lg border px-3 py-4 text-center shadow-sm backdrop-blur-xl"
      role="alert"
    >
      {error.kind === "failed" && error.providerDiagnostic !== undefined ? (
        <ProviderDiagnosticMessage diagnostic={error.providerDiagnostic} />
      ) : (
        <p className="text-muted-foreground text-xs leading-snug">{text}</p>
      )}
      {analysableVersion !== null &&
        decisionLinkElement({
          children: t("caseLaw.analysis.errors.openLanguageVersion", {
            language: languageLabel(format, analysableVersion.language),
          }),
          className: "text-foreground text-xs font-medium hover:underline",
          params: createCaseLawDecisionRouteParams({
            caseNumber: analysableVersion.caseNumber,
            country: analysableVersion.country,
            court: analysableVersion.court,
            decisionId: analysableVersion.id,
            language: analysableVersion.language,
            languageAlternates: languageVersions,
            slug: analysableVersion.slug,
          }),
        })}
      {retryAt !== undefined && !retryTimePassed && (
        <p className="text-muted-foreground text-xs leading-snug">
          {t("caseLaw.analysis.errors.retryAfter", {
            time: format.dateTime(retryAt, MEDIUM_DATE_SHORT_TIME_FORMAT),
          })}
        </p>
      )}
      {analysisRetryOf(error, retryTimePassed) !== "none" && (
        <Button onClick={onRetry} size="sm" variant="muted">
          <SparklesIcon className="size-3" />
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
};
