import { useRouter } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type { CorrespondenceChannel } from "@stll/api-contract/correspondence";
import { Button } from "@stll/ui/button";

import { openEntityInInspector } from "@/components/chat/entity-open";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { getCurrentWorkspaceDocument } from "@/lib/workspaces/use-workspace-view-params";

import { OriginalSignature } from "./original-signature";

const SOURCE_LABEL_KEYS = {
  email: {
    title: "correspondence.uploadedFile",
    open: "correspondence.openSourceFile",
  },
  data_box: {
    title: "correspondence.dataBox.uploaded",
    open: "correspondence.dataBox.openFile",
  },
} as const satisfies Record<
  CorrespondenceChannel,
  Record<"title" | "open", TranslationKey>
>;

// An uploaded record links the file it was read from. An email file keeps the
// attachments, so opening it shows them; a data-box `.zfo` file keeps the
// system's seal. Its uploader is its user filer.
export const UploadedSource = ({
  channel,
  uploader,
  signatureDomain,
  sourceEntityId,
  workspaceId,
}: {
  channel: CorrespondenceChannel;
  uploader:
    { userName: string | null; userStatus: "active" | "deleted" } | undefined;
  signatureDomain: string | null;
  sourceEntityId: string;
  workspaceId: string;
}) => {
  const labels = SOURCE_LABEL_KEYS[channel];
  const t = useTranslations();
  const router = useRouter();
  let uploaderName = t("common.unknownUser");
  if (uploader?.userStatus === "deleted") {
    uploaderName = t("tasks.deletedAccount");
  } else if (uploader?.userName) {
    uploaderName = uploader.userName;
  }
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="text-sm font-medium">{t(labels.title)}</h2>
      <span className="block space-y-1 text-xs">
        <span className="block">
          <bdi dir="auto">
            {t("correspondence.uploadedBy", { name: uploaderName })}
          </bdi>
        </span>
        <OriginalSignature domain={signatureDomain} />
        {channel === "data_box" && (
          <span className="text-muted-foreground block">
            {t("correspondence.dataBox.sealNotVerified")}
          </span>
        )}
      </span>
      <Button
        className="min-h-11"
        onClick={() =>
          detached(
            openEntityInInspector({
              documentOnScreen: getCurrentWorkspaceDocument(
                router.state.matches,
              ),
              entityId: sourceEntityId,
              label: t(labels.title),
              workspaceId,
            }),
            "correspondence.open-source-file",
          )
        }
        size="sm"
        type="button"
        variant="outline"
      >
        {t(labels.open)}
      </Button>
    </section>
  );
};
