import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Checkbox } from "@stll/ui/components/checkbox";
import { Field, FieldLabel } from "@stll/ui/components/field";
import { Frame, FramePanel } from "@stll/ui/components/frame";

import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/features/organization-settings/organization-settings-queries";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

export const PromptCachingCard = () => {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data: settings } = useQuery(
    organizationSettingsOptions(activeOrganizationId),
  );

  const mutation = useSettingsMutation({
    // Send only the prompt-caching field so a stale matter-numbering
    // value from `settings` cannot roll back a concurrent admin's
    // matter-numbering change.
    mutationFn: async (nextEnabled: boolean) =>
      unwrapEden(
        await api["organization-settings"].post({
          promptCachingEnabled: nextEnabled,
        }),
      ),
    invalidate: organizationSettingsKeys.all,
    successToast: { title: t("success.promptCachingUpdated") },
    errorToast: { title: t("errors.actionFailed") },
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
