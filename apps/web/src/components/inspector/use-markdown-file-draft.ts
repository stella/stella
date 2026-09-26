import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { getMarkdownDraftSyncDecision } from "@/components/inspector/file-tab-panel.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { MARKDOWN_MIME } from "@/lib/consts";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { filesKeys, textFileOptions } from "@/lib/files/queries";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

type MarkdownSyncInput = {
  fieldId: string;
  isDirty: boolean;
  isMarkdownDisplay: boolean;
  serverText: string | undefined;
};

const shouldSyncMarkdownDraft = ({
  lastSyncInput,
  syncInput,
}: {
  lastSyncInput: MarkdownSyncInput | null;
  syncInput: MarkdownSyncInput;
}) =>
  lastSyncInput === null ||
  lastSyncInput.fieldId !== syncInput.fieldId ||
  lastSyncInput.isDirty !== syncInput.isDirty ||
  lastSyncInput.isMarkdownDisplay !== syncInput.isMarkdownDisplay ||
  lastSyncInput.serverText !== syncInput.serverText;

type UseMarkdownFileDraftOptions = {
  filePropertyId: string | undefined;
  isMarkdownDisplay: boolean;
  tab: FileTab;
};

/**
 * The editable draft of a workspace Markdown file: the server text, the local
 * draft seeded from it, and the save that uploads the draft as a new version.
 */
export const useMarkdownFileDraft = ({
  filePropertyId,
  isMarkdownDisplay,
  tab,
}: UseMarkdownFileDraftOptions) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const replaceFileFieldId = useInspectorTabsStore((s) => s.replaceFileFieldId);
  const textQuery = useQuery({
    ...textFileOptions({ workspaceId: tab.workspaceId, fieldId: tab.id }),
    enabled: isMarkdownDisplay,
  });
  const [draft, setDraft] = useState("");
  const [draftSourceFieldId, setDraftSourceFieldId] = useState<string | null>(
    null,
  );
  const text = textQuery.data?.text ?? "";
  const isDirty = draft !== text;
  const [lastSyncInput, setLastSyncInput] = useState<MarkdownSyncInput | null>(
    null,
  );
  const saveMutation = useMutation({
    mutationFn: async ({
      entityId,
      fileName,
      text: nextText,
      workspaceId,
    }: {
      entityId: string;
      fieldId: string;
      fileName: string;
      propertyId?: string | undefined;
      text: string;
      workspaceId: string;
    }) => {
      // This path serializes editor text into a fixed Markdown file; it cannot
      // carry user-supplied DOCX bytes that require attached-template preflight.
      const file = new File([nextText], fileName, { type: MARKDOWN_MIME });
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["upload-version"].post({
          entityId: toSafeId<"entity">(entityId),
          file,
        });

      return unwrapEden(response);
    },
    onSuccess: async (response, variables) => {
      replaceFileFieldId(variables.fieldId, {
        id: response.fieldId,
        fileName: variables.fileName,
        label: tab.label,
        mimeType: MARKDOWN_MIME,
        pdfFileId: null,
        ...(variables.propertyId ? { propertyId: variables.propertyId } : {}),
      });
      stellaToast.add({
        title: t("workspaces.files.versionUploaded"),
        type: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: filesKeys.all() }),
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(variables.workspaceId),
        }),
      ]);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("workspaces.files.versionUploadFailed"),
        description: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
  });

  const syncInput = {
    fieldId: tab.id,
    isDirty,
    isMarkdownDisplay,
    serverText: textQuery.data?.text,
  } satisfies MarkdownSyncInput;
  if (shouldSyncMarkdownDraft({ lastSyncInput, syncInput })) {
    setLastSyncInput(syncInput);
    if (!isMarkdownDisplay) {
      setDraftSourceFieldId(null);
    } else {
      const decision = getMarkdownDraftSyncDecision({
        ...syncInput,
        lastSyncedFieldId: draftSourceFieldId,
      });
      if (decision.type === "sync") {
        setDraftSourceFieldId(decision.fieldId);
        setDraft(decision.text);
      }
    }
  }

  const discard = () => {
    setDraft(text);
  };
  const save = () => {
    saveMutation.mutate({
      entityId: tab.entityId,
      fieldId: tab.id,
      fileName: tab.fileName,
      propertyId: filePropertyId,
      text: draft,
      workspaceId: tab.workspaceId,
    });
  };

  return {
    discard,
    isDirty,
    isSaving: saveMutation.isPending,
    save,
    setDraft,
    text,
    textQuery,
  };
};

export type MarkdownFileDraft = ReturnType<typeof useMarkdownFileDraft>;
