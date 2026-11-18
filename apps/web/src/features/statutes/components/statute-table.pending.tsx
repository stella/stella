import { useTranslations } from "use-intl";

import { STATUTE_COLUMN_IDS } from "@stll/api-contract/public-law-table";
import type { StatuteColumnId } from "@stll/api-contract/public-law-table";
import {
  CalendarClockIcon,
  CalendarIcon,
  CircleDotIcon,
  HashIcon,
  HistoryIcon,
  ScrollTextIcon,
  ShapesIcon,
} from "@stll/ui/icons";
import type { LucideIcon } from "@stll/ui/icons";

import {
  PublicLawTableHeaderFace,
  PublicLawTableSkeleton,
} from "@/components/public-law-table/public-law-table.pending";
import type { PublicLawSkeletonColumn } from "@/components/public-law-table/public-law-table.pending";
import { SELECT_COLUMN_SIZE } from "@/components/workspaces/table/table-schema";
import {
  STATUTE_COLUMN_LABEL_KEYS,
  STATUTE_COLUMN_MODEL,
} from "@/features/statutes/statute-columns.logic";

// The statute columns' faces and the statute table before its rows: what the
// loading view draws, and what the table's headers and chooser wear.

/** The icon each statute column wears in its header menu and the chooser. */
export const STATUTE_COLUMN_ICONS = {
  act: ScrollTextIcon,
  type: ShapesIcon,
  validity: CircleDotIcon,
  firstVersion: CalendarIcon,
  amendments: HistoryIcon,
  lastAmended: CalendarClockIcon,
  citedBy: HashIcon,
} as const satisfies Record<StatuteColumnId, LucideIcon>;

export const StatuteColumnIcon = ({
  className = "size-3.5",
  column,
}: {
  className?: string;
  column: StatuteColumnId;
}) => {
  const Icon = STATUTE_COLUMN_ICONS[column];
  return <Icon className={className} />;
};

/**
 * The statute table waiting for its first page: the row numbers and every
 * statute column at its default width, under their headers.
 */
export const StatuteTableSkeleton = ({
  expectedRowCount,
}: {
  expectedRowCount?: number | undefined;
}) => {
  const t = useTranslations();
  const columns: PublicLawSkeletonColumn[] = [
    { id: "row-number", header: null, size: SELECT_COLUMN_SIZE },
    ...STATUTE_COLUMN_IDS.map((column) => ({
      id: column,
      header: (
        <PublicLawTableHeaderFace
          icon={<StatuteColumnIcon column={column} />}
          label={t(STATUTE_COLUMN_LABEL_KEYS[column])}
        />
      ),
      size: STATUTE_COLUMN_MODEL[column].size,
    })),
  ];

  return (
    <PublicLawTableSkeleton
      columns={columns}
      expectedRowCount={expectedRowCount}
    />
  );
};
