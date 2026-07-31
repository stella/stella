import { useId } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Checkbox } from "@stll/ui/components/checkbox";
import { Field, FieldLabel } from "@stll/ui/components/field";
import { Frame, FramePanel } from "@stll/ui/components/frame";

import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { documentOcrAvailabilityOptions } from "@/queries/document-ocr-availability";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/queries/organization-settings";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

const SEARCHABLE_TEXT_MODE = "searchable-text";
const DOCUMENT_PROCESSING_OFF_MODE = "off";

export const DocumentProcessingCard = () => {
  const t = useTranslations();
  const checkboxId = useId();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data: settings } = useQuery(
    organizationSettingsOptions(activeOrganizationId),
  );
  const { data: documentOcrAvailability } = useQuery(
    documentOcrAvailabilityOptions({ organizationId: activeOrganizationId }),
  );

  const mutation = useSettingsMutation({
    mutationFn: async (nextEnabled: boolean) =>
      unwrapEden(
        await api["organization-settings"].post({
          documentProcessingMode: nextEnabled
            ? SEARCHABLE_TEXT_MODE
            : DOCUMENT_PROCESSING_OFF_MODE,
        }),
      ),
    invalidate: organizationSettingsKeys.all,
    successToast: {
      title: t("settings.organization.documentProcessing.updated"),
    },
    errorToast: { title: t("errors.actionFailed") },
  });

  if (!settings) {
    return null;
  }

  const enabled = settings.documentProcessingMode === SEARCHABLE_TEXT_MODE;
  const unavailable = documentOcrAvailability?.available !== true;

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <h2 className="text-sm font-medium">
            {t("settings.organization.documentProcessing.title")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("settings.organization.documentProcessing.description")}
          </p>
          {unavailable ? (
            <p className="text-destructive text-xs" role="status">
              {t("errors.api.serviceUnavailable")}
            </p>
          ) : null}
          <Field className="flex-row items-center gap-2">
            <Checkbox
              checked={enabled}
              disabled={mutation.isPending || (!enabled && unavailable)}
              id={checkboxId}
              onCheckedChange={(next) => {
                mutation.mutate(next);
              }}
            />
            <FieldLabel htmlFor={checkboxId}>
              {t("settings.organization.documentProcessing.toggleLabel")}
            </FieldLabel>
          </Field>
        </div>
      </FramePanel>
    </Frame>
  );
};
