import { useOptimistic, useTransition } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/components/frame";
import { stellaToast } from "@stll/ui/components/toast";

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
  const serverSelected = settings?.practiceJurisdictions ?? [];

  // `useOptimistic` mirrors the server value and applies the latest user
  // intent until the wrapping transition settles. When the mutation
  // rejects (or the request unmounts), React automatically reverts the
  // optimistic value back to the passthrough server state — no manual
  // rollback needed.
  const [optimisticSelected, applyOptimisticSelection] = useOptimistic(
    serverSelected,
    (_current, next: PracticeJurisdiction[]) => next,
  );
  const [, startSelectionTransition] = useTransition();

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
            onChange={(next) => {
              startSelectionTransition(async () => {
                applyOptimisticSelection(next);
                await updateMutation.mutateAsync(next).catch(() => {
                  // The error toast is surfaced via the mutation's
                  // `onError`. Swallow here so the transition resolves
                  // and React reverts `optimisticSelected` to the
                  // server value automatically.
                });
              });
            }}
            selected={optimisticSelected}
          />
        </div>
      </FramePanel>
    </Frame>
  );
};
