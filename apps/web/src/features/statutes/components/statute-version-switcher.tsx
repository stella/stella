import { useCallback } from "react";

import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";

import { formatValidityDate } from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";

export type StatuteVersion = {
  id: string;
  versionValidFrom: string | null;
  versionValidTo: string | null;
};

type StatuteVersionSwitcherProps = {
  currentVersionId: string;
  onVersionChange: (documentId: string) => void;
  versions: readonly StatuteVersion[];
};

/**
 * Picks the consolidated version to read. Selecting one navigates to that
 * version's own document, so the URL always names the text on screen.
 */
export const StatuteVersionSwitcher = ({
  currentVersionId,
  onVersionChange,
  versions,
}: StatuteVersionSwitcherProps) => {
  const t = useTranslations();
  const format = useFormatter();

  const handleValueChange = useCallback(
    (value: string | null) => {
      if (value !== null && value !== "" && value !== currentVersionId) {
        onVersionChange(value);
      }
    },
    [currentVersionId, onVersionChange],
  );

  if (versions.length < 2) {
    return null;
  }

  const formatBoundary = (value: string | null): string =>
    formatValidityDate(value, format) ?? t("statutes.openEnded");

  return (
    <Select onValueChange={handleValueChange} value={currentVersionId}>
      <SelectTrigger
        aria-label={t("common.version")}
        className="w-full sm:w-72"
      >
        <SelectValue placeholder={t("common.version")} />
      </SelectTrigger>
      <SelectPopup>
        {versions.map((version) => (
          <SelectItem key={version.id} value={version.id}>
            {t("statutes.validity", {
              from: formatBoundary(version.versionValidFrom),
              to: formatBoundary(version.versionValidTo),
            })}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};
