/**
 * Which columns of the decision table the chooser offers.
 *
 * Two groups: the decision columns and the organization's questions. The
 * chooser knows only that a column has a name, an icon and an id that is
 * either hidden or not, so a question is hidden the same way a court is.
 */

import { TagIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { PropertyIcon } from "@stll/workspace-ui/property-icon";

import type { ColumnToggleGroup } from "@/components/workspaces/table/column-toggle";
import type {
  DecisionColumnId,
  DecisionExtraColumn,
  DecisionReferenceColumnKind,
} from "@/features/case-law/decision-columns.logic";
import {
  DECISION_COLUMN_ICONS,
  useDecisionTableSchema,
} from "@/features/case-law/decision-table-columns";
import { questionColumnId } from "@/features/case-law/research/question-columns.logic";
import type { QuestionColumnSurface } from "@/features/case-law/research/question-columns.logic";

const isDecisionColumnId = (id: string): id is DecisionColumnId =>
  Object.hasOwn(DECISION_COLUMN_ICONS, id);

type UseDecisionColumnGroupsOptions = {
  extraColumns?: readonly DecisionExtraColumn[] | undefined;
  questions: QuestionColumnSurface;
  referenceKind: DecisionReferenceColumnKind;
};

export const useDecisionColumnGroups = ({
  extraColumns,
  questions,
  referenceKind,
}: UseDecisionColumnGroupsOptions): ColumnToggleGroup[] => {
  const t = useTranslations();
  const schema = useDecisionTableSchema({
    extraColumns,
    questions,
    referenceKind,
  });

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

  return [
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
};

const DecisionColumnIcon = ({ columnId }: { columnId: DecisionColumnId }) => {
  const Icon = DECISION_COLUMN_ICONS[columnId];
  return <Icon className="size-3.5" />;
};
