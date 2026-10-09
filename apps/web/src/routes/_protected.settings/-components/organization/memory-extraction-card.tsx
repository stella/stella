import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldLabel } from "@stll/ui/field";
import { Frame, FramePanel } from "@stll/ui/frame";
import { stellaToast } from "@stll/ui/toast";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/lib/organization/settings-queries";
import { useQueryView } from "@/lib/use-query-view";

export const MemoryExtractionCard = () => {
  const t = useTranslations("settings.organization.memoryExtraction");
  const successT = useTranslations("success");
  const errorsT = useTranslations("errors");
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
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

  const mutation = useMutation({
    // Send only the memory-extraction field so a stale matter-numbering
    // or prompt-caching value from `settings` cannot roll back a
    // concurrent admin's change to those settings.
    mutationFn: async (nextEnabled: boolean) => {
      const response = await api["organization-settings"].post({
        memoryExtractionEnabled: nextEnabled,
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: organizationSettingsKeys.all,
      });
      stellaToast.add({
        title: successT("memoryExtractionUpdated"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      notifyUserError(error, errorsT("actionFailed"));
    },
  });

  if (!settings) {
    return <QueryViewFeedback view={settingsView} />;
  }

  const enabled = settings.memoryExtractionEnabled;

  return (
    <Frame>
      <QueryViewFeedback view={settingsView} />
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <h2 className="text-sm font-medium">{t("title")}</h2>
          <p className="text-muted-foreground text-xs">{t("description")}</p>
          <Field className="flex-row items-center gap-2">
            <Checkbox
              checked={enabled}
              disabled={mutation.isPending}
              onCheckedChange={(next) => {
                mutation.mutate(next);
              }}
            />
            <FieldLabel>{t("toggleLabel")}</FieldLabel>
          </Field>
        </div>
      </FramePanel>
    </Frame>
  );
};
