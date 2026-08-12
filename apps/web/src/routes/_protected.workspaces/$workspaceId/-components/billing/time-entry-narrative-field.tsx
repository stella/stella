import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Label } from "@stll/ui/components/label";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import { AiRewriteControl } from "@/components/ai-rewrite-control";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { polishTimeEntryNarrative } from "@/lib/workspaces/time-entries-api";

type TimeEntryNarrativeFieldProps = {
  id: string;
  onChange: (value: string) => void;
  rows?: number | undefined;
  value: string;
  workspaceId: string;
};

/** One narrative field for every time-entry form, including its safe AI polish. */
export const TimeEntryNarrativeField = ({
  id,
  onChange,
  rows = 4,
  value,
  workspaceId,
}: TimeEntryNarrativeFieldProps) => {
  const tAi = useTranslations("ai");
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const analytics = useAnalytics();
  const [isPolishing, setIsPolishing] = useState(false);
  const getLatestValue = useLatestCallback(() => value);

  const polishNarrative = async (instruction: string) => {
    const baseline = getLatestValue();
    const narrative = baseline.trim();
    if (narrative.length === 0 || isPolishing) {
      return;
    }

    setIsPolishing(true);
    const requestResult = await Result.tryPromise(
      async () =>
        await polishTimeEntryNarrative({ instruction, narrative, workspaceId }),
    );
    setIsPolishing(false);

    if (Result.isError(requestResult)) {
      analytics.captureError(requestResult.error);
      stellaToast.add({
        type: "error",
        title: tAi("editWithAI"),
        description: userErrorFromThrown(
          requestResult.error,
          tCommon("unexpectedError"),
        ),
      });
      return;
    }

    if (getLatestValue() !== baseline) {
      stellaToast.add({
        type: "info",
        title: tAi("rewriteDraftChanged"),
      });
      return;
    }

    onChange(requestResult.value.narrative);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <Label htmlFor={id}>{tCommon("description")}</Label>
        <AiRewriteControl
          disabled={value.trim().length === 0}
          isPending={isPolishing}
          onRewrite={(instruction) => {
            detached(
              polishNarrative(instruction),
              "time-entry-narrative-field.polish-narrative",
            );
          }}
        />
      </div>
      <Textarea
        id={id}
        maxLength={10_000}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={tBilling("narrativePlaceholder")}
        required
        rows={rows}
        value={value}
      />
    </div>
  );
};
