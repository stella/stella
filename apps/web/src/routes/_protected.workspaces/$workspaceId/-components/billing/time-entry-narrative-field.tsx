import { useRef, useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Label } from "@stll/ui/components/label";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import { AiRewriteControl } from "@/components/ai-rewrite-control";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
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
  const latestValueRef = useRef(value);
  latestValueRef.current = value;

  const polishNarrative = async (instruction: string) => {
    const baseline = latestValueRef.current;
    const narrative = baseline.trim();
    if (narrative.length === 0 || isPolishing) {
      return;
    }

    setIsPolishing(true);
    const requestResult = await Result.tryPromise(
      async () =>
        await api["time-entries"]({
          workspaceId: toSafeId<"workspace">(workspaceId),
        })["polish-narrative"].post({ narrative, instruction }),
    );
    setIsPolishing(false);

    if (Result.isError(requestResult)) {
      analytics.captureError(requestResult.error);
      stellaToast.add({
        type: "error",
        title: t("ai.editWithAI"),
        description: t("common.unexpectedError"),
      });
      return;
    }

    const response = requestResult.value;
    if (response.error) {
      analytics.captureError(toAPIError(response.error));
      stellaToast.add({
        type: "error",
        title: t("ai.editWithAI"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    if (latestValueRef.current !== baseline) {
      stellaToast.add({
        type: "info",
        title: t("ai.rewriteDraftChanged"),
      });
      return;
    }

    onChange(response.data.narrative);
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
        dir="auto"
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
