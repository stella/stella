import { useState } from "react";

import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { api } from "@/lib/api";
import { deepLKeys } from "@/lib/deepl/queries";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { webSearchKeysKeys } from "@/lib/web-search/queries";

import type {
  KeySettingsDraft,
  SectionFeedback,
} from "../-components/organization/ai-settings-section";
import { useSettingsMutation } from "./use-settings-mutation";

const KEY_SECTIONS = {
  deepl: {
    invalidate: deepLKeys.all,
    set: async (apiKey: string) =>
      unwrapEden(await api["organization-settings"].deepl.post({ apiKey })),
    clear: async () =>
      unwrapEden(await api["organization-settings"].deepl.delete()),
  },
  search: {
    invalidate: webSearchKeysKeys.all,
    set: async (apiKey: string) =>
      unwrapEden(
        await api["organization-settings"]["web-search-key"].post({
          kind: "search",
          apiKey,
        }),
      ),
    clear: async () =>
      unwrapEden(
        await api["organization-settings"]["web-search-key"].delete({
          kind: "search",
        }),
      ),
  },
  fetch: {
    invalidate: webSearchKeysKeys.all,
    set: async (apiKey: string) =>
      unwrapEden(
        await api["organization-settings"]["web-search-key"].post({
          kind: "fetch",
          apiKey,
        }),
      ),
    clear: async () =>
      unwrapEden(
        await api["organization-settings"]["web-search-key"].delete({
          kind: "fetch",
        }),
      ),
  },
} as const;

type KeySection = keyof typeof KEY_SECTIONS;
type KeyChange = Exclude<KeySettingsDraft, { action: "untouched" }>;

const useKeySection = (section: KeySection) => {
  const t = useTranslations("common");
  const [draft, setDraft] = useState<KeySettingsDraft>({ action: "untouched" });
  const [feedback, setFeedback] = useState<SectionFeedback>({ status: "idle" });
  const mutation = useSettingsMutation({
    invalidate: KEY_SECTIONS[section].invalidate,
    mutationFn: async (change: KeyChange) => {
      switch (change.action) {
        case "set":
          return await KEY_SECTIONS[section].set(change.apiKey.trim());
        case "cleared":
          return await KEY_SECTIONS[section].clear();
        default:
          change satisfies never;
          return panic("Unhandled AI settings key change");
      }
    },
    onSuccess: () => {
      setDraft({ action: "untouched" });
      setFeedback({ status: "saved" });
    },
  });
  return {
    draft,
    feedback,
    disabled: mutation.isPending,
    isDirty: draft.action !== "untouched",
    canSave: draft.action !== "set" || draft.apiKey.trim().length > 0,
    onChange: (apiKey: string) => {
      setDraft(
        apiKey.length === 0
          ? { action: "untouched" }
          : { action: "set", apiKey },
      );
      setFeedback({ status: "idle" });
    },
    onRemove: () => {
      setDraft({ action: "cleared" });
      setFeedback({ status: "idle" });
    },
    save: async () => {
      if (draft.action === "untouched") {
        return;
      }
      setFeedback({ status: "saving" });
      const result = await Result.tryPromise({
        try: async () => await mutation.mutateAsync(draft),
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

export const useAISettingsKeys = () => {
  const sections = {
    deepl: useKeySection("deepl"),
    search: useKeySection("search"),
    fetch: useKeySection("fetch"),
  } satisfies Record<KeySection, ReturnType<typeof useKeySection>>;
  return sections;
};
