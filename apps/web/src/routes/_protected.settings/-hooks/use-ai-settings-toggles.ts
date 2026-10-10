import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/queries/organization-settings";
import type { OrganizationSettings } from "@/queries/organization-settings";

import type { SectionFeedback } from "../-components/organization/ai-settings-section";
import { useSettingsMutation } from "./use-settings-mutation";

const TOGGLE_SECTION = {
  promptCaching: "promptCachingEnabled",
  documentProcessing: "documentProcessingMode",
  memoryExtraction: "memoryExtractionEnabled",
} as const;
type ToggleSection = keyof typeof TOGGLE_SECTION;
const SEARCHABLE_TEXT = "searchable-text";
const PROCESSING_OFF = "off";

const useToggleSection = (section: ToggleSection) => {
  const t = useTranslations("common");
  const { activeOrganizationId, id } = useAuthenticatedUser();
  const queryClient = useQueryClient();
  const options = organizationSettingsOptions({
    organizationId: activeOrganizationId,
    userId: id,
  });
  const settingsView = useQueryView(useQuery(options));
  useQueryViewError(settingsView);
  const settings =
    settingsView.type === "items" ? settingsView.items : undefined;
  const [value, setValue] = useState<boolean | null>(null);
  const [feedback, setFeedback] = useState<SectionFeedback>({ status: "idle" });
  const stored =
    section === "documentProcessing"
      ? settings?.documentProcessingMode === SEARCHABLE_TEXT
      : settings?.[TOGGLE_SECTION[section]];
  const mutation = useSettingsMutation({
    invalidate: organizationSettingsKeys.all,
    mutationFn: async (next: boolean) => {
      switch (section) {
        case "promptCaching":
          return unwrapEden(
            await api["organization-settings"].post({
              promptCachingEnabled: next,
            }),
          );
        case "documentProcessing":
          return unwrapEden(
            await api["organization-settings"].post({
              documentProcessingMode: next ? SEARCHABLE_TEXT : PROCESSING_OFF,
            }),
          );
        case "memoryExtraction":
          return unwrapEden(
            await api["organization-settings"].post({
              memoryExtractionEnabled: next,
            }),
          );
        default:
          section satisfies never;
          return panic("Unhandled AI settings toggle section");
      }
    },
    onSuccess: (_, next) => {
      queryClient.setQueryData(options.queryKey, (current) => {
        if (current === undefined) {
          return current;
        }
        switch (section) {
          case "promptCaching":
            return { ...current, promptCachingEnabled: next };
          case "documentProcessing":
            return {
              ...current,
              documentProcessingMode: next ? SEARCHABLE_TEXT : PROCESSING_OFF,
            } satisfies OrganizationSettings;
          case "memoryExtraction":
            return { ...current, memoryExtractionEnabled: next };
          default:
            section satisfies never;
            return panic("Unhandled AI settings toggle cache update");
        }
      });
      setValue(null);
      setFeedback({ status: "saved" });
    },
  });
  return {
    value,
    feedback,
    disabled: mutation.isPending,
    isDirty: value !== null && value !== stored,
    canSave: settings !== undefined,
    onChange: (next: boolean) => {
      setValue(next === stored ? null : next);
      setFeedback({ status: "idle" });
    },
    save: async () => {
      if (value === null || value === stored) {
        return;
      }
      setFeedback({ status: "saving" });
      const result = await Result.tryPromise({
        try: async () => await mutation.mutateAsync(value),
        catch: (error: unknown) => error,
      });

      if (Result.isError(result)) {
        const error = result.error;
        setFeedback({
          status: "error",
          message: APIError.is(error)
            ? (error.rawMessage ?? error.message)
            : t("somethingWentWrong"),
        });
      }
    },
  };
};

export const useAISettingsToggles = () =>
  ({
    promptCaching: useToggleSection("promptCaching"),
    documentProcessing: useToggleSection("documentProcessing"),
    memoryExtraction: useToggleSection("memoryExtraction"),
  }) satisfies Record<ToggleSection, ReturnType<typeof useToggleSection>>;
