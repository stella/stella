import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";

import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import { getExportFileName } from "@/lib/export-download";
import { toSafeId } from "@/lib/safe-id";
import { downloadFile } from "@/lib/utils";

/**
 * Download a skill as the Agent Skills archive `skills.export` builds: one
 * folder named after the skill with SKILL.md and its files. The server's
 * file name wins; the id is only a fallback.
 */
const downloadSkillArchive = async ({
  failedMessage,
  skillId,
}: {
  failedMessage: string;
  skillId: string;
}): Promise<void> => {
  const response = await api
    .skills({ skillId: toSafeId<"agentSkill">(skillId) })
    .export.get();
  if (response.error) {
    notifyUserError(toAPIError(response.error), failedMessage);
    return;
  }
  const { data } = response;
  const blob = await Result.tryPromise(async () =>
    data instanceof Response ? await data.blob() : data,
  );
  if (Result.isError(blob) || !(blob.value instanceof Blob)) {
    notifyUserProblem(failedMessage);
    return;
  }
  const fileName =
    data instanceof Response
      ? getExportFileName(data.headers.get("content-disposition"))
      : null;
  downloadFile(blob.value, fileName ?? `skill-${skillId}.zip`);
};

/** The skill page's "Download as ZIP" action. */
export const SkillArchiveDownloadButton = ({
  skillId,
}: {
  skillId: string;
}) => {
  const t = useTranslations();
  const label = t("workspaces.files.downloadAsZip");
  return (
    <Button
      aria-label={label}
      onClick={() =>
        detached(
          downloadSkillArchive({
            failedMessage: t("workspaces.files.downloadFailed"),
            skillId,
          }),
          "skill-editor.download-archive",
        )
      }
      size="icon-sm"
      title={label}
      variant="ghost"
    >
      <DownloadIcon className="size-4" />
    </Button>
  );
};
