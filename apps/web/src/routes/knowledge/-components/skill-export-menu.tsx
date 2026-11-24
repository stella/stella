import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";

import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";

/** The package formats the export endpoint accepts. */
type SkillExportFormat = NonNullable<
  Parameters<ReturnType<typeof api.skills>["export"]["get"]>[0]
>["query"]["format"];

const EXPORT_FORMATS = [
  ["zip", "knowledge.agentSkills.exportAsZip"],
  ["skill", "knowledge.agentSkills.exportAsSkill"],
] as const satisfies readonly (readonly [SkillExportFormat, TranslationKey])[];

/**
 * Ask for a package and hand its short-lived link to the browser, which
 * downloads it as an attachment under the package's file name. Nothing a
 * view shows changes, so no cache is touched.
 */
const exportSkillPackage = async ({
  failedMessage,
  format,
  skillId,
}: {
  failedMessage: string;
  format: SkillExportFormat;
  skillId: string;
}): Promise<void> => {
  const response = await api
    .skills({ skillId: toSafeId<"agentSkill">(skillId) })
    .export.get({ query: { format } });
  if (response.error) {
    notifyUserError(toAPIError(response.error), failedMessage);
    return;
  }
  const link = document.createElement("a");
  link.href = response.data.downloadUrl;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
};

type SkillExportMenuProps = {
  skillId: string;
};

/**
 * Downloads the skill as a portable package: SKILL.md, every file and the
 * manifest, as a .zip or the same archive named .skill.
 */
export const SkillExportMenu = ({ skillId }: SkillExportMenuProps) => {
  const t = useTranslations();
  const [pending, setPending] = useState(false);
  const label = t("knowledge.agentSkills.exportSkill");

  const start = (format: SkillExportFormat) => {
    setPending(true);
    detached(
      exportSkillPackage({
        failedMessage: t("knowledge.agentSkills.exportFailed"),
        format,
        skillId,
      }).finally(() => setPending(false)),
      "skill-editor.export-package",
    );
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-busy={pending}
            aria-label={label}
            disabled={pending}
            disabledReason={t("common.preparing")}
            size="icon-sm"
            title={label}
            variant="ghost"
          />
        }
      >
        {pending ? (
          <Loader label={label} size="sm" />
        ) : (
          <DownloadIcon className="size-4" />
        )}
      </MenuTrigger>
      <MenuPopup>
        {EXPORT_FORMATS.map(([format, itemLabel]) => (
          <MenuItem
            disabled={pending}
            key={format}
            onClick={() => start(format)}
          >
            {t(itemLabel)}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
};
