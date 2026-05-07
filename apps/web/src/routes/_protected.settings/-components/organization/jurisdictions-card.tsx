import { useEffect, useState } from "react";

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

  // Local optimistic state so rapid edits compose against the latest user
  // intent rather than the (stale) server-cached `selected`. Without this,
  // clicking two countries before the first mutation settles makes the
  // second click compute `next` from the pre-first-click value and silently
  // drop the first selection.
  const [localSelected, setLocalSelected] = useState<PracticeJurisdiction[]>(
    () => settings?.practiceJurisdictions ?? [],
  );
  const [hasLocalEdit, setHasLocalEdit] = useState(false);

  // Reconcile from server only when the user isn't mid-edit. Once mutations
  // settle and we're back in sync, drop the local-edit flag so future server
  // refreshes (e.g., another tab edited) flow back through.
  useEffect(() => {
    if (!hasLocalEdit && settings) {
      setLocalSelected(settings.practiceJurisdictions);
    }
  }, [settings, hasLocalEdit]);

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
      setHasLocalEdit(false);
    },
    onError: (error, attemptedNext) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      // Roll back to whatever the server still reports.
      setLocalSelected(settings?.practiceJurisdictions ?? []);
      setHasLocalEdit(false);
      // attemptedNext intentionally ignored after rollback.
      void attemptedNext;
    },
  });

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <JurisdictionPicker
            onChange={(next) => {
              setLocalSelected(next);
              setHasLocalEdit(true);
              updateMutation.mutate(next);
            }}
            selected={localSelected}
          />
        </div>
      </FramePanel>
    </Frame>
  );
};
