import { useOptimistic, useRef, useState, useTransition } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/components/frame";

import { JurisdictionPicker } from "@/components/jurisdiction-picker";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/features/organization-settings/organization-settings-queries";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import type { PracticeJurisdiction } from "@/lib/jurisdictions";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

export const OrganizationJurisdictionsCard = () => {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data: settings } = useQuery(
    organizationSettingsOptions(activeOrganizationId),
  );
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
    mutationFn: async (next: PracticeJurisdiction[]) =>
      unwrapEden(
        await api["organization-settings"]["practice-jurisdictions"].post({
          practiceJurisdictions: next,
        }),
      ),
    invalidate: organizationSettingsKeys.all,
    errorToast: { title: t("errors.actionFailed") },
  });

  return (
    <Frame>
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
                try {
                  await updateMutation.mutateAsync(next);
                } catch {
                  // The error toast is surfaced via the mutation's
                  // `onError`. Swallow here so the transition resolves
                  // and React reverts `optimisticSelected` to the
                  // server value automatically.
                } finally {
                  if (selectionGenerationRef.current === generation) {
                    setImmediateSelected(null);
                  }
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
