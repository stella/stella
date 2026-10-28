import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { StatuteChangeCounts } from "@stll/legal-ast/statute-compare";
import { cn } from "@stll/ui/utils";

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
      <span className="min-w-0 truncate">
        {parts.length === 0
          ? t("statutes.versionChangesNone")
          : parts.map(partLabel).join(" · ")}
      </span>
      {inserted + deleted === 0 ? null : (
        <span
          aria-label={wordsLabel}
          className="flex shrink-0 gap-px"
          role="img"
          title={wordsLabel}
        >
          {versionChangeBar(changes.words).map((cell, index) => (
            <span
              className={cn("size-1.5 rounded-xs", BAR_CELL_CLASS[cell])}
              data-cell={cell}
              // oxlint-disable-next-line react/no-array-index-key -- a fixed five-cell bar; cells never reorder.
              key={index}
            />
          ))}
        </span>
      )}
    </span>
  );
};
