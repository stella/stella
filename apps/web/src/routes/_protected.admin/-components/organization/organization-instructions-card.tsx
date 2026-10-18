import { useId, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Frame, FramePanel } from "@stll/ui/frame";

import { MarkdownHybridEditor } from "@/components/markdown/markdown-hybrid-editor";
import type { MarkdownHybridEditorHandle } from "@/components/markdown/markdown-hybrid-editor";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { usePermissions } from "@/hooks/use-permissions";
import { useUnsavedWork } from "@/hooks/use-unsaved-work";
import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { useQueryView } from "@/lib/use-query-view";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/queries/organization-settings";
import type { OrganizationSettings } from "@/queries/organization-settings";
import { useSettingsMutation } from "@/routes/_protected.admin/-hooks/use-settings-mutation";

import { SettingsLeaveGuard } from "../settings-leave-guard";

export const OrganizationInstructionsCard = () => {
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const view = useQueryView(
    useQuery(
      organizationSettingsOptions({
        organizationId: activeOrganizationId,
        userId,
      }),
    ),
  );
  if (view.type !== "items") {
    return <QueryViewFeedback view={view} />;
  }
  return (
    <>
      <QueryViewFeedback view={view} />
      <OrganizationInstructionsEditor
        key={activeOrganizationId}
        settings={view.items}
      />
    </>
  );
};

const OrganizationInstructionsEditor = ({
  settings,
}: {
  settings: OrganizationSettings;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const headingId = useId();
  const descriptionId = useId();
  const editor = useRef<MarkdownHybridEditorHandle>(null);
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  const [editorRevision, setEditorRevision] = useState(0);
  const [draft, setDraft] = useState(settings.aiInstructions);
  const [saved, setSaved] = useState(settings.aiInstructions);
  const [serverInstructions, setServerInstructions] = useState(
    settings.aiInstructions,
  );
  const dirty = draft !== saved;
  if (settings.aiInstructions !== serverInstructions) {
    setServerInstructions(settings.aiInstructions);
    setSaved(settings.aiInstructions);
    if (!dirty) {
      setDraft(settings.aiInstructions);
      setEditorRevision((revision) => revision + 1);
    }
  }
  const characterCount = draft.length;
  const tooLong = characterCount > settings.aiInstructionsMaxLength;
  const blocker = useUnsavedWork({
    surface: "ai-provider-settings",
    guard: "confirm-navigation",
    isDirty: canEdit && dirty,
  });
  const mutation = useSettingsMutation({
    mutationFn: async (aiInstructions: string) =>
      unwrapEden(await api["organization-settings"].post({ aiInstructions })),
    invalidate: organizationSettingsKeys.all,
    successToast: { title: t("common.saved") },
    errorToast: { title: t("errors.actionFailed") },
    onSuccess: (_data, aiInstructions) => {
      setSaved(aiInstructions);
      setEditorRevision((revision) => revision + 1);
    },
    // captureForSave locks the editor; remount even when a fast rejection
    // settles before React renders the mutation's pending state.
    onError: () => setEditorRevision((revision) => revision + 1),
  });

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-3">
          <h2 id={headingId} className="text-sm font-medium">
            {t("organization.aiInstructions.title")}
          </h2>
          <p id={descriptionId} className="text-muted-foreground text-xs">
            {t("organization.aiInstructions.description")}
          </p>
          <div
            role="group"
            aria-labelledby={headingId}
            aria-describedby={descriptionId}
            className="min-h-40 rounded-md border"
          >
            <MarkdownHybridEditor
              key={editorRevision}
              ref={editor}
              markdown={draft}
              imagePolicy="data-only"
              onMarkdownChange={setDraft}
              changeEmission="immediate"
              readOnly={!canEdit || mutation.isPending}
              className="min-h-40"
            />
          </div>
          <p className="text-muted-foreground text-end text-xs tabular-nums">
            {t("organization.aiInstructions.characterCount", {
              count: format.number(characterCount),
              maxLength: format.number(settings.aiInstructionsMaxLength),
            })}
          </p>
          {tooLong && (
            <p role="alert" className="text-destructive text-xs">
              {t("organization.aiInstructions.tooLong", {
                maxLength: format.number(settings.aiInstructionsMaxLength),
              })}
            </p>
          )}
          {canEdit && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                loading={mutation.isPending}
                disabled={!dirty || tooLong || mutation.isPending}
                onClick={() => {
                  const next = editor.current?.captureForSave() ?? draft;
                  setDraft(next);
                  if (next.length > settings.aiInstructionsMaxLength) {
                    setEditorRevision((revision) => revision + 1);
                    return;
                  }
                  mutation.mutate(next);
                }}
              >
                {t("common.save")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={draft.length === 0 || mutation.isPending}
                onClick={() => {
                  editor.current?.resetMarkdown("");
                  setDraft("");
                }}
              >
                {t("common.remove")}
              </Button>
            </div>
          )}
        </div>
      </FramePanel>
      <SettingsLeaveGuard blocker={blocker} />
    </Frame>
  );
};
