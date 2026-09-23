import { ChevronDownIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { StatuteStatusDot } from "@/features/statutes/components/statute-validity-indicator";
import type { PublicStatuteVersion } from "@/features/statutes/queries/statutes";
import {
  formatValidityDate,
  formatValidityRange,
} from "@/features/statutes/statute-format";
import {
  resolveStatuteDisplayStatus,
  STATUTE_STATUS_LABEL_KEYS,
  type StatuteDisplayStatus,
} from "@/features/statutes/statute-status";
import { useFormatter } from "@/i18n/formatting-context";

const ROW_LABELLED_STATUSES: ReadonlySet<StatuteDisplayStatus> = new Set([
  "repealed",
  "draft",
]);

type RowStatusLabelOptions = {
  displayStatus: StatuteDisplayStatus | null;
  inForce: boolean;
  label: (status: StatuteDisplayStatus) => string;
  status: string;
};

/**
 * The in-force row and statuses its position cannot imply; nothing else.
 * "In force" is the API's default marker, not the stored status: an older
 * consolidation can keep `current` with an overlapping open-ended window.
 */
const rowStatusLabel = ({
  displayStatus,
  inForce,
  label,
  status,
}: RowStatusLabelOptions): string | null => {
  if (inForce) {
    return label("current");
  }
  if (displayStatus === null) {
    return status;
  }
  return ROW_LABELLED_STATUSES.has(displayStatus) ? label(displayStatus) : null;
};

type StatuteVersionMenuProps = {
  currentVersionId: string;
  onVersionChange: (documentId: string) => void;
  versions: readonly PublicStatuteVersion[];
};

/**
 * Compact top-bar history for one legislative Work. Version selection lives
 * here so the document itself does not grow a second navigation control.
 */
export const StatuteVersionMenu = ({
  currentVersionId,
  onVersionChange,
  versions,
}: StatuteVersionMenuProps) => {
  const t = useTranslations();
  const format = useFormatter();

  if (versions.length < 2) {
    return null;
  }

  const currentVersion = versions.find(
    (version) => version.id === currentVersionId,
  );
  if (currentVersion === undefined) {
    return null;
  }

  const rows = versions.map((version) => {
    const displayStatus = resolveStatuteDisplayStatus({
      status: version.status,
      validFrom: version.versionValidFrom,
    });
    return { displayStatus, version };
  });

  const versionLabel = (version: PublicStatuteVersion): string => {
    const futureDate =
      version.versionValidTo === null &&
      resolveStatuteDisplayStatus({
        status: version.status,
        validFrom: version.versionValidFrom,
      }) === "future"
        ? formatValidityDate(version.versionValidFrom, format)
        : null;
    // An open end reads "until now", which a version not yet in force has
    // not reached: it is dated by the day it takes effect instead.
    return futureDate === null
      ? formatValidityRange({
          format,
          openEnded: t("statutes.openEnded"),
          validFrom: version.versionValidFrom,
          validTo: version.versionValidTo,
        })
      : t("lawHome.inForceFrom", { date: futureDate });
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="sm" variant="ghost">
            <span className="max-w-52 truncate tabular-nums">
              {versionLabel(currentVersion)}
            </span>
            <ChevronDownIcon className="size-3.5" />
          </Button>
        }
      />
      <PopoverPopup
        align="end"
        className="w-[min(28rem,var(--available-width))]"
        padding="none"
        side="bottom"
      >
        <ol className="relative py-1">
          <span
            aria-hidden="true"
            className="bg-border absolute inset-y-4 start-[1.15rem] w-px"
          />
          {rows.map(({ displayStatus, version }) => {
            const selected = version.id === currentVersionId;
            const inForce = version.isDefault;
            // The dot's colour says future or past; only the version in
            // force, and a status the colour cannot tell apart, get a label.
            const rowLabel = rowStatusLabel({
              displayStatus,
              inForce,
              label: (key) => t(STATUTE_STATUS_LABEL_KEYS[key]),
              status: version.status,
            });

            return (
              <li className="relative" key={version.id}>
                <button
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "hover:bg-muted focus-visible:ring-ring grid w-full grid-cols-[auto_1fr] items-start gap-3 rounded-md px-4 text-start transition-colors focus-visible:ring-2 focus-visible:outline-none",
                    inForce ? "py-3" : "py-2",
                    selected && "bg-muted/60",
                  )}
                  disabled={selected}
                  onClick={() => onVersionChange(version.id)}
                  type="button"
                >
                  <span className="bg-popover relative z-10 mt-1 flex size-2 items-center justify-center">
                    <StatuteStatusDot
                      status={version.status}
                      validFrom={version.versionValidFrom}
                    />
                  </span>
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block text-sm tabular-nums",
                        inForce && "font-semibold",
                        !inForce && !selected && "text-muted-foreground",
                      )}
                    >
                      {versionLabel(version)}
                    </span>
                    {rowLabel === null ? null : (
                      <span
                        className={cn(
                          "text-2xs mt-0.5 block font-medium tracking-wide uppercase",
                          inForce ? "text-success" : "text-muted-foreground",
                        )}
                      >
                        {rowLabel}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </PopoverPopup>
    </Popover>
  );
};
