import {
  CalendarIcon,
  FileDigitIcon,
  FileTextIcon,
  GlobeIcon,
  HashIcon,
  LandmarkIcon,
  LanguagesIcon,
  QuoteIcon,
  ShapesIcon,
} from "@stll/ui/icons";
import type { LucideIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";

import { PendingText } from "@/components/pending-text";
import {
  PublicLawTableHeaderFace,
  PublicLawTableSkeleton,
} from "@/components/public-law-table/public-law-table.pending";
import type { PublicLawSkeletonColumn } from "@/components/public-law-table/public-law-table.pending";
import { SELECT_COLUMN_SIZE } from "@/components/workspaces/table/workspace-grid";
import {
  DECISION_COLUMN_IDS,
  DECISION_COLUMN_LABEL_KEYS,
  DECISION_COLUMN_MODEL,
  DEFAULT_HIDDEN_DECISION_COLUMN_IDS,
} from "@/features/case-law/decision-columns.logic";
import type { DecisionColumnId } from "@/features/case-law/decision-columns.logic";

// The decision columns' icons and the decision table before its rows: what the
// loading view draws, and what the table's headers, the chooser and the find
// wear.

/** The icon each decision column wears in its header menu and the chooser. */
export const DECISION_COLUMN_ICONS = {
  caseNumber: FileDigitIcon,
  summary: FileTextIcon,
  court: LandmarkIcon,
  country: GlobeIcon,
  date: CalendarIcon,
  type: ShapesIcon,
  headnote: QuoteIcon,
  citedBy: HashIcon,
  language: LanguagesIcon,
} as const satisfies Record<DecisionColumnId, LucideIcon>;

const isShownByDefault = (column: DecisionColumnId) =>
  !DEFAULT_HIDDEN_DECISION_COLUMN_IDS.some((hidden) => hidden === column);

/**
 * The decision table waiting for its first page: the selection column and the
 * columns a reader sees before choosing, at their default widths, under their
 * headers.
 */
export const DecisionTableSkeleton = ({
  expectedRowCount,
}: {
  expectedRowCount?: number | undefined;
}) => {
  const columns: PublicLawSkeletonColumn[] = [
    {
      id: "select",
      header: (
        <div className="flex h-full items-center justify-center">
          <Skeleton className="size-4 rounded-sm" />
        </div>
      ),
      size: SELECT_COLUMN_SIZE,
    },
    ...DECISION_COLUMN_IDS.filter(isShownByDefault).map((column) => {
      const Icon = DECISION_COLUMN_ICONS[column];
      return {
        id: column,
        header: (
          <PublicLawTableHeaderFace
            icon={<Icon className="size-3.5" />}
            label={
              <PendingText
                barClassName="w-16 max-w-full"
                id={DECISION_COLUMN_LABEL_KEYS[column]}
              />
            }
          />
        ),
        size: DECISION_COLUMN_MODEL[column].size,
      };
    }),
  ];

  return (
    <PublicLawTableSkeleton
      columns={columns}
      expectedRowCount={expectedRowCount}
    />
  );
};
