import { Frame, FramePanel } from "@stll/ui/components/frame";
import { stellaToast } from "@stll/ui/components/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { JurisdictionPicker } from "@/components/jurisdiction-picker";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { PracticeJurisdiction } from "@/lib/jurisdictions";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/routes/_protected.organization/-settings-queries";

export const OrganizationJurisdictionsCard = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(organizationSettingsOptions);

  const selected: readonly PracticeJurisdiction[] =
    settings?.practiceJurisdictions ?? [];

  const updateMutation = useMutation({
    mutationFn: async (next: PracticeJurisdiction[]) => {
      const response = await api["organization-settings"][
        "practice-jurisdictions"
      ].post({ practiceJurisdictions: next });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: organizationSettingsKeys.all,
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <JurisdictionPicker
            onChange={(next) => updateMutation.mutate(next)}
            selected={selected}
          />
        </div>
      </FramePanel>
    </Frame>
  );
};
