import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Label } from "@stll/ui/components/label";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import { AiRewriteControl } from "@/components/ai-rewrite-control";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";

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
  const t = useTranslations();
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
    const requestResult = await Result.tryPromise(async () => {
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      })["polish-narrative"].post({ narrative, instruction });
      return unwrapEden(response);
    });
    setIsPolishing(false);

    if (Result.isError(requestResult)) {
      analytics.captureError(requestResult.error);
      stellaToast.add({
        type: "error",
        title: t("ai.editWithAI"),
        description: userErrorFromThrown(
          requestResult.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    if (getLatestValue() !== baseline) {
      stellaToast.add({
        type: "info",
        title: t("ai.rewriteDraftChanged"),
      });
      return;
    }

    onChange(requestResult.value.narrative);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <Label htmlFor={id}>{t("common.description")}</Label>
        <AiRewriteControl
          disabled={value.trim().length === 0}
          isPending={isPolishing}
          onRewrite={(instruction) => {
            detached(
              polishNarrative(instruction),
              "TimeEntryNarrativeField.polishNarrative",
            );
          }}
        />
      </div>
      <Textarea
        id={id}
        maxLength={10_000}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={t("billing.narrativePlaceholder")}
        required
        rows={rows}
        value={value}
      />
    </div>
  );
};
