import { useTranslations } from "use-intl";

import type {
  LegislationExpressionEligibility,
  LegislationInconsistentVersion,
} from "@stll/api-contract/legislation-expression";

import { ineligibleExpressionLabelKey } from "@/features/statutes/statute-expression";
import { useFormatter } from "@/i18n/formatting-context";
import { formatStatedWindow } from "@/lib/statute-format";

type StatedWindow = {
  versionValidFrom: string | null;
  versionValidTo: string | null;
};

/** The dates a publisher stated for a version, never read as a period in force. */
const StatedWindowText = ({
  versionValidFrom,
  versionValidTo,
}: StatedWindow) => {
  const t = useTranslations();
  const format = useFormatter();

  return t("statutes.statedWindow", {
    range: formatStatedWindow({
      format,
      openEnded: t("statutes.openEnded"),
      validFrom: versionValidFrom,
      validTo: versionValidTo,
    }),
  });
};

const NOTICE_CLASS =
  "bg-muted/60 text-foreground mx-auto w-full max-w-prose rounded-md px-4 py-3 text-sm";

/**
 * Shown over a version that cannot apply, opened by its id: what it is, and
 * the dates its publisher stated, so the wording below is never read as the
 * text in force on those dates.
 */
export const StatuteIneligibleVersionNotice = ({
  version,
}: {
  version: LegislationExpressionEligibility & StatedWindow;
}) => {
  const t = useTranslations();
  const label = ineligibleExpressionLabelKey(version);
  if (label === null) {
    return null;
  }

  return (
    <div className={NOTICE_CLASS} role="note">
      <p className="font-medium">{t(label)}</p>
      <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">
        <StatedWindowText
          versionValidFrom={version.versionValidFrom}
          versionValidTo={version.versionValidTo}
        />
      </p>
    </div>
  );
};

/**
 * Shown for a day the publisher's own inconsistent dates leave without an
 * in-force reading: the reason, and the versions responsible with the dates
 * their publisher stated.
 */
export const StatuteWindowGapNotice = ({
  versions,
}: {
  versions: readonly LegislationInconsistentVersion[];
}) => {
  const t = useTranslations();

  return (
    <div className={NOTICE_CLASS} role="note">
      <p className="font-medium">{t("statutes.publisherWindowInconsistent")}</p>
      <ul className="text-muted-foreground mt-1 flex flex-col gap-0.5 text-xs tabular-nums">
        {versions.map((version) => (
          <li key={version.id}>
            <StatedWindowText
              versionValidFrom={version.versionValidFrom}
              versionValidTo={version.versionValidTo}
            />
          </li>
        ))}
      </ul>
    </div>
  );
};
