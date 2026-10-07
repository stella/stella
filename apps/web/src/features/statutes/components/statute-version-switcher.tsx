import { useCallback } from "react";

import { useTranslations } from "use-intl";

import type { LegislationExpressionEligibility } from "@stll/api-contract/legislation-expression";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { ineligibleExpressionLabelKey } from "@/features/statutes/statute-expression";
import { useFormatter } from "@/i18n/formatting-context";
import { formatValidityRange } from "@/lib/statute-format";

export type StatuteVersion = LegislationExpressionEligibility & {
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

  return (
    <Select onValueChange={handleValueChange} value={currentVersionId}>
      <SelectTrigger
        aria-label={t("common.version")}
        className="w-full sm:w-72"
      >
        <SelectValue placeholder={t("common.version")} />
      </SelectTrigger>
      <SelectPopup>
        {versions.map((version) => {
          const range = formatValidityRange({
            format,
            openEnded: t("statutes.openEnded"),
            validFrom: version.versionValidFrom,
            validTo: version.versionValidTo,
          });
          // A version that cannot apply is named for what it is; its dates
          // are the publisher's statement, not a period in force.
          const ineligibleLabel = ineligibleExpressionLabelKey(version);
          return (
            <SelectItem key={version.id} value={version.id}>
              {ineligibleLabel === null
                ? range
                : t("statutes.ineligibleVersion", {
                    label: t(ineligibleLabel),
                    range,
                  })}
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
};
