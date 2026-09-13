/**
 * Which columns the results table shows.
 *
 * The workspace table's own chooser, over two groups: the decision columns and
 * the organization's questions. The menu knows only that a column has a name,
 * an icon and an id that is either hidden or not, so a question is hidden the
 * same way a court is.
 */

import { TagIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { PropertyIcon } from "@stll/workspace-ui/property-icon";

import { ColumnToggle } from "@/components/workspaces/table/column-toggle";
import type { ColumnToggleGroup } from "@/components/workspaces/table/column-toggle";
import type { DecisionTableLayout } from "@/features/case-law/decision-column-preferences.logic";
import type {
  DecisionColumnId,
  DecisionExtraColumn,
} from "@/features/case-law/decision-columns.logic";
import {
  DECISION_COLUMN_ICONS,
  useDecisionTableSchema,
} from "@/features/case-law/decision-table-columns";
import { questionColumnId } from "@/features/case-law/research/question-columns.logic";
import type { QuestionColumnSurface } from "@/features/case-law/research/question-columns.logic";

const isDecisionColumnId = (id: string): id is DecisionColumnId =>
  Object.hasOwn(DECISION_COLUMN_ICONS, id);

type DecisionColumnToggleProps = {
  extraColumns?: readonly DecisionExtraColumn[] | undefined;
  layout: DecisionTableLayout;
  onLayoutChange: (layout: DecisionTableLayout) => void;
  questions: QuestionColumnSurface;
};

export const DecisionColumnToggle = ({
  extraColumns,
  layout,
  onLayoutChange,
  questions,
}: DecisionColumnToggleProps) => {
  const t = useTranslations();
  const schema = useDecisionTableSchema({ extraColumns, questions });

  // Read off the schema, so a column the table gained shows here without an
  // edit and a column it lost cannot be offered.
  const decisionColumns = schema.columns.flatMap((column) => {
    if (!column.capabilities.hide) {
      return [];
    }
    if (isDecisionColumnId(column.id)) {
      return [
        {
          id: column.id,
          name: column.label,
          icon: <DecisionColumnIcon columnId={column.id} />,
        },
      ];
    }
    return column.render.type === "decision-extra"
      ? [
          {
            id: column.id,
            name: column.label,
            icon: <TagIcon className="size-3.5" />,
          },
        ]
      : [];
  });
  const questionColumns =
    questions.type === "available"
      ? questions.columns.map((column) => ({
          id: questionColumnId(column.id),
          name: column.question,
          icon: (
            <PropertyIcon className="size-3.5" type={column.content.type} />
          ),
        }))
      : [];

  const groups: ColumnToggleGroup[] = [
    {
      id: "decision",
      label: t("common.caseLaw"),
      columns: decisionColumns,
    },
    {
      id: "questions",
      label: t("caseLaw.research.title"),
      columns: questionColumns,
    },
  ];

  return (
    <ColumnToggle
      groups={groups}
      hidden={layout.hidden}
      onChange={(hidden) => onLayoutChange({ ...layout, hidden })}
    />
  );
};

const DecisionColumnIcon = ({ columnId }: { columnId: DecisionColumnId }) => {
  const Icon = DECISION_COLUMN_ICONS[columnId];
  return <Icon className="size-3.5" />;
};
