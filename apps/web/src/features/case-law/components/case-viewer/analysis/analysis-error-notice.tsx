import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { SparklesIcon } from "@stll/ui/icons";

import {
  analysisErrorMessage,
  type AnalysisErrorMessage,
} from "@/features/case-law/components/case-viewer/analysis/analysis-error.logic";
import { analysisRetryOf } from "@/features/case-law/components/case-viewer/analysis/use-decision-analysis";
import type { AnalysisError } from "@/features/case-law/queries/decision-analysis";

const useAnalysisErrorText = (message: AnalysisErrorMessage): string => {
  const t = useTranslations();
  switch (message.kind) {
    case "keyed":
      return t(message.key, message.values);
    case "generic":
      return t("errors.api.server");
    case "unavailable":
      return t("caseLaw.analysis.errors.unavailable");
    default:
      message satisfies never;
      return panic("Unhandled analysis error message");
  }
};

/**
 * Why the analysis column holds no analysis, and the way to ask again when
 * asking again can help. A failed run names whose key it used, so a reader
 * on their organization's own key knows where the fault sits.
 */
export const AnalysisErrorNotice = ({
  error,
  onRetry,
}: {
  error: AnalysisError;
  onRetry: () => void;
}) => {
  const t = useTranslations();
  const text = useAnalysisErrorText(analysisErrorMessage(error));
  return (
    <div
      className="bg-background/75 supports-[backdrop-filter]:bg-background/55 mx-2 mt-8 flex flex-col items-center gap-2 rounded-lg border px-3 py-4 text-center shadow-sm backdrop-blur-xl"
      role="alert"
    >
      <p className="text-muted-foreground text-xs leading-snug">{text}</p>
      {analysisRetryOf(error) !== "none" && (
        <Button onClick={onRetry} size="sm" variant="muted">
          <SparklesIcon className="size-3" />
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
};
