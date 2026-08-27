import { CheckIcon, HistoryIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import { useFormatter } from "@/i18n/formatting-context";

import type {
  MemberNameLookup,
  SkillRevisionSummary,
} from "./skill-history.logic";

type RevisionMenuProps = {
  revisions: readonly SkillRevisionSummary[];
  /** The revision the live body is currently diffed against, if any. */
  comparedRevisionId: string | null;
  canManage: boolean;
  authorName: MemberNameLookup;
  onCompare: (revisionId: string | null) => void;
  onRestore: (revisionId: string) => void;
};

/**
 * The body's revision history. Picking a revision diffs the live text against
 * it; restoring writes that revision's text back over the live body and is
 * offered only to the people who may edit the skill directly.
 */
export const RevisionMenu = ({
  revisions,
  comparedRevisionId,
  canManage,
  authorName,
  onCompare,
  onRestore,
}: RevisionMenuProps) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <Menu>
      <MenuTrigger
        nativeButton
        render={
          <Button size="xs" variant={comparedRevisionId ? "outline" : "ghost"}>
            <HistoryIcon className="size-3.5" />
            {t("common.history")}
          </Button>
        }
      />
      <MenuPopup align="start" className="max-h-80 w-72">
        {revisions.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">
            {t("skillHistory.noRevisions")}
          </p>
        ) : (
          revisions.map((revision) => (
            <MenuItem
              key={revision.id}
              onClick={() => {
                onCompare(
                  revision.id === comparedRevisionId ? null : revision.id,
                );
              }}
            >
              <CheckIcon
                className={cn(
                  "size-3.5 shrink-0",
                  revision.id !== comparedRevisionId && "opacity-0",
                )}
              />
              <span className="truncate tabular-nums">
                {t("skillHistory.revisionLabel", {
                  author: authorName(revision.createdBy),
                  date: format.dateTime(new Date(revision.createdAt), {
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                  }),
                  number: revision.revisionNumber,
                })}
              </span>
            </MenuItem>
          ))
        )}
        {comparedRevisionId === null ? null : (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                onCompare(null);
              }}
            >
              {t("skillHistory.clearComparison")}
            </MenuItem>
            {canManage ? (
              <MenuItem
                onClick={() => {
                  onRestore(comparedRevisionId);
                }}
              >
                {t("skillHistory.restoreRevision")}
              </MenuItem>
            ) : null}
          </>
        )}
      </MenuPopup>
    </Menu>
  );
};
