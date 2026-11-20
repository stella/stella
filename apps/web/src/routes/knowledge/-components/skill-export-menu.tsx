import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";

import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
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

type SkillExportMenuProps = {
  skillId: string;
};

/**
 * Downloads the skill as a portable package: SKILL.md, every file and the
 * manifest, as a .zip or the same archive named .skill.
 */
export const SkillExportMenu = ({ skillId }: SkillExportMenuProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const exportPackage = useMutation({
    mutationFn: async (format: SkillExportFormat) => {
      const response = await api
        .skills({ skillId: toSafeId<"agentSkill">(skillId) })
        .export.get({ query: { format } });
      // The presigned URL answers as an attachment under its file name.
      const { downloadUrl } = unwrapApiResponse(response);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
    },
    onError: (error, format) => {
      analytics.captureError(error, {
        fingerprintKey: "SkillExportMenu:failure",
        scope: { type: "handler", handlerId: `skill-export.${format}` },
      });
      notifyUserError(error, t("knowledge.agentSkills.exportFailed"));
    },
  });

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-busy={exportPackage.isPending}
            aria-label={t("knowledge.agentSkills.exportSkill")}
            disabled={exportPackage.isPending}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        {exportPackage.isPending ? (
          <Loader label={t("knowledge.agentSkills.exportSkill")} size="sm" />
        ) : (
          <DownloadIcon className="size-4" />
        )}
      </MenuTrigger>
      <MenuPopup>
        {EXPORT_FORMATS.map(([format, label]) => (
          <MenuItem
            disabled={exportPackage.isPending}
            key={format}
            onClick={() => exportPackage.mutate(format)}
          >
            {t(label)}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
};
