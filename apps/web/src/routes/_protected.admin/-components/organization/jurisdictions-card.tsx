import { useOptimistic, useRef, useState, useTransition } from "react";

import { useQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/frame";

import { JurisdictionPicker } from "@/components/jurisdiction-picker";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapApiResponse } from "@/lib/errors/api";
import type { PracticeJurisdiction } from "@/lib/jurisdictions";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/lib/organization/settings-queries";
import { useQueryView } from "@/lib/use-query-view";
import { useSettingsMutation } from "@/routes/_protected.admin/-hooks/use-settings-mutation";

export const OrganizationJurisdictionsCard = () => {
  const t = useTranslations();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const settingsQuery = useQuery(
    organizationSettingsOptions({
      organizationId: activeOrganizationId,
      userId,
    }),
  );
  const settingsView = useQueryView(settingsQuery);
  const settings =
    settingsView.type === "items" ? settingsView.items : undefined;
  const serverSelected = settings ? settings.practiceJurisdictions : [];

  // `useOptimistic` mirrors the server value and applies the latest user
  // intent until the wrapping transition settles. When the mutation
  // rejects (or the request unmounts), React automatically reverts the
  // optimistic value back to the passthrough server state — no manual
  // rollback needed.
  const [optimisticSelected, applyOptimisticSelection] = useOptimistic(
    serverSelected,
    (_current, next: PracticeJurisdiction[]) => next,
  );
  const [immediateSelected, setImmediateSelected] = useState<
    PracticeJurisdiction[] | null
  >(null);
  const selectionGenerationRef = useRef(0);
  const selected = immediateSelected ?? optimisticSelected;
  const [, startSelectionTransition] = useTransition();

  const updateMutation = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId:
        "OrganizationJurisdictionsCard.updateMutation.useSettingsMutation",
    },
    mutationFn: async (next: PracticeJurisdiction[]) =>
      unwrapApiResponse(
        await api["organization-settings"]["practice-jurisdictions"].post({
          practiceJurisdictions: next,
        }),
      ),
    invalidate: organizationSettingsKeys.all,
    errorToast: { title: t("errors.actionFailed") },
  });

  if (settingsView.type !== "items") {
    return <QueryViewFeedback view={settingsView} />;
  }

  return (
    <Frame>
      <QueryViewFeedback view={settingsView} />
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <p className="text-muted-foreground text-sm">
            {t("settings.organization.practiceJurisdictionsDescription")}
          </p>
          <JurisdictionPicker
            onChange={(next) => {
              const generation = selectionGenerationRef.current + 1;
              selectionGenerationRef.current = generation;
              setImmediateSelected(next);
              startSelectionTransition(async () => {
                applyOptimisticSelection(next);
                // The error toast is surfaced via the mutation's `onError`.
                // Settling as a Result lets the transition resolve, and React
                // reverts `optimisticSelected` to the server value.
                const result = await Result.tryPromise({
                  try: async () => await updateMutation.mutateAsync(next),
                  catch: (error) => error,
                });
                result.unwrapOr(undefined);
                if (selectionGenerationRef.current === generation) {
                  setImmediateSelected(null);
                }
              });
            }}
            selected={selected}
          />
        </div>
      </FramePanel>
    </Frame>
  );
};
