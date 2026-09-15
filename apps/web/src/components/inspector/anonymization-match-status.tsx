import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { useAnonymizationPipelineStatus } from "@/components/inspector/inspector-anonymization-store";

type AnonymizationMatchStatusProps = {
  matchCount: number;
  pipelineStatus: ReturnType<typeof useAnonymizationPipelineStatus>;
};

export const AnonymizationMatchStatus = ({
  matchCount,
  pipelineStatus,
}: AnonymizationMatchStatusProps) => {
  const t = useTranslations();

  switch (pipelineStatus) {
    case "error":
      return (
        <div className="text-muted-foreground bg-muted/40 rounded-md px-3 py-2 text-xs">
          {t("inspector.anonymization.scanFailed")}
        </div>
      );
    case "ready":
      return (
        <div className="bg-muted/40 text-foreground rounded-md px-3 py-2 text-xs">
          {t("inspector.anonymization.matchCount", {
            count: String(matchCount),
          })}
        </div>
      );
    case "idle":
    case "running":
      return (
        <div className="text-muted-foreground bg-muted/40 rounded-md px-3 py-2 text-xs">
          {t("inspector.anonymization.detectingMatches")}
        </div>
      );
    default:
      pipelineStatus satisfies never;
      return panic(
        `Unhandled anonymization pipeline status: ${String(pipelineStatus)}`,
      );
  }
};
