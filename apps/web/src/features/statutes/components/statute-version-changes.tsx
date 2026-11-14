import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { StatuteChangeCounts } from "@stll/legal-ast/statute-compare";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import {
  versionChangeBar,
  versionChangeParts,
} from "@/features/statutes/components/statute-version-changes.logic";
import type {
  VersionChangeBarCell,
  VersionChangePart,
} from "@/features/statutes/components/statute-version-changes.logic";

const BAR_CELL_CLASS = {
  inserted: "bg-success",
  deleted: "bg-destructive",
  empty: "bg-border",
} as const satisfies Record<VersionChangeBarCell, string>;

type StatuteVersionChangesProps = {
  changes: StatuteChangeCounts;
  className?: string;
};

/**
 * What a consolidation changed against the one before it, under its dates in
 * the version list: the provisions changed, added and removed (only the
 * kinds that happened), and a diff-stat bar of the words inserted and
 * deleted. Counts only; the list never calls a version minor or major.
 */
export const StatuteVersionChanges = ({
  changes,
  className,
}: StatuteVersionChangesProps) => {
  const t = useTranslations();
  const partLabel = ({ count, kind }: VersionChangePart): string => {
    switch (kind) {
      case "changed":
        return t("statutes.versionChangesChanged", { count });
      case "added":
        return t("statutes.versionChangesAdded", { count });
      case "removed":
        return t("statutes.versionChangesRemoved", { count });
      default:
        kind satisfies never;
        return panic("Unhandled provision change kind");
    }
  };
  const parts = versionChangeParts(changes);
  const { deleted, inserted } = changes.words;
  const wordsLabel = t("statutes.versionChangesWords", { deleted, inserted });

  return (
    <span
      className={cn(
        "text-muted-foreground flex min-w-0 items-center gap-2 text-xs",
        className,
      )}
      data-slot="statute-version-changes"
    >
      <TruncatedText render={<span />}>
        {parts.length === 0
          ? t("statutes.versionChangesNone")
          : parts.map(partLabel).join(" · ")}
      </TruncatedText>
      {inserted + deleted === 0 ? null : (
        <Tooltip
          content={wordsLabel}
          render={
            <span
              aria-label={wordsLabel}
              className="flex shrink-0"
              role="img"
            />
          }
        >
          <span className="flex gap-px">
            {Object.entries(versionChangeBar(changes.words)).map(
              ([position, cell]) => (
                <span
                  className={cn("size-1.5 rounded-xs", BAR_CELL_CLASS[cell])}
                  data-cell={cell}
                  key={position}
                />
              ),
            )}
          </span>
        </Tooltip>
      )}
    </span>
  );
};
