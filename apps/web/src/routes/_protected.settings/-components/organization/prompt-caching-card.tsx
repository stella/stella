import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Checkbox } from "@stll/ui/components/checkbox";
import { Field, FieldLabel } from "@stll/ui/components/field";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/routes/_protected.organization/-settings-queries";

export const PromptCachingCard = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(organizationSettingsOptions);

  const mutation = useMutation({
    // Send only the prompt-caching field so a stale matter-numbering
    // value from `settings` cannot roll back a concurrent admin's
    // matter-numbering change.
    mutationFn: async (nextEnabled: boolean) => {
      const response = await api["organization-settings"].post({
        promptCachingEnabled: nextEnabled,
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
        title: t("success.promptCachingUpdated"),
        type: "success",
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

  if (!settings) {
    return null;
  }

  const enabled = settings.promptCachingEnabled;

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <h2 className="text-sm font-medium">
            {t("settings.organization.promptCaching.title")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("settings.organization.promptCaching.description")}
          </p>
          <Field className="flex-row items-center gap-2">
            <Checkbox
              checked={enabled}
              disabled={mutation.isPending}
              onCheckedChange={(next) => {
                mutation.mutate(next);
              }}
            />
            <FieldLabel>
              {t("settings.organization.promptCaching.toggleLabel")}
            </FieldLabel>
          </Field>
        </div>
      </FramePanel>
    </Frame>
  );
};
