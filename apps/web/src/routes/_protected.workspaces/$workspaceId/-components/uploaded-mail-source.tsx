import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { openEntityInInspector } from "@/components/chat/entity-open";
import { detached } from "@/lib/detached";

import { OriginalSignature } from "./original-signature";

// An uploaded record links the email file it was read from; the file keeps the
// attachments, so opening it shows them. Its uploader is its user filer.
export const UploadedSource = ({
  uploader,
  signatureDomain,
  sourceEntityId,
  workspaceId,
}: {
  uploader:
    | { userName: string | null; userStatus: "active" | "deleted" }
    | undefined;
  signatureDomain: string | null;
  sourceEntityId: string;
  workspaceId: string;
}) => {
  const t = useTranslations();
  let uploaderName = t("common.unknownUser");
  if (uploader?.userStatus === "deleted") {
    uploaderName = t("tasks.deletedAccount");
  } else if (uploader?.userName) {
    uploaderName = uploader.userName;
  }
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="text-sm font-medium">
        {t("correspondence.uploadedFile")}
      </h2>
      <span className="block space-y-1 text-xs">
        <span className="block">
          <bdi dir="auto">
            {t("correspondence.uploadedBy", { name: uploaderName })}
          </bdi>
        </span>
        <OriginalSignature domain={signatureDomain} />
      </span>
      <Button
        className="min-h-11"
        onClick={() =>
          detached(
            openEntityInInspector(
              sourceEntityId,
              t("correspondence.uploadedFile"),
              workspaceId,
            ),
            "correspondence.open-source-file",
          )
        }
        size="sm"
        type="button"
        variant="outline"
      >
        {t("correspondence.openSourceFile")}
      </Button>
    </section>
  );
};
