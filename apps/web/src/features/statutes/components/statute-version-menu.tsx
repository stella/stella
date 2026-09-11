import { ChevronDownIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { StatuteStatusDot } from "@/features/statutes/components/statute-validity-indicator";
import type { PublicStatuteVersion } from "@/features/statutes/queries/statutes";
import { formatValidityRange } from "@/features/statutes/statute-format";
import {
  resolveStatuteDisplayStatus,
  STATUTE_STATUS_LABEL_KEYS,
} from "@/features/statutes/statute-status";
import { useFormatter } from "@/i18n/formatting-context";

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

  const versionLabel = (version: PublicStatuteVersion): string =>
    formatValidityRange({
      format,
      openEnded: t("statutes.openEnded"),
      validFrom: version.versionValidFrom,
      validTo: version.versionValidTo,
    });

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
        className="w-[min(28rem,var(--available-width))] p-0"
        side="bottom"
      >
        <ol className="relative py-1">
          <span
            aria-hidden="true"
            className="bg-border absolute inset-y-4 start-[1.15rem] w-px"
          />
          {versions.map((version) => {
            const selected = version.id === currentVersionId;
            const displayStatus = resolveStatuteDisplayStatus({
              status: version.status,
              validFrom: version.versionValidFrom,
            });
            const statusLabel =
              displayStatus === null
                ? version.status
                : t(STATUTE_STATUS_LABEL_KEYS[displayStatus]);

            return (
              <li className="relative" key={version.id}>
                <button
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "hover:bg-muted focus-visible:ring-ring grid w-full grid-cols-[auto_1fr] items-start gap-3 rounded-md px-4 py-3 text-start transition-colors focus-visible:ring-2 focus-visible:outline-none",
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
                        selected && "font-semibold",
                      )}
                    >
                      {versionLabel(version)}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-[0.7rem] font-medium tracking-wide uppercase">
                      {statusLabel}
                    </span>
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
