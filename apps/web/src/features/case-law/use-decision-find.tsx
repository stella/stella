/**
 * Find-in-table over decision rows: the shared public-law find, over the
 * columns a decision row has (its own and the organization's questions).
 */

import type { RefObject } from "react";

import { useTranslations } from "use-intl";

import { usePublicLawFind } from "@/components/public-law-table/use-public-law-find";
import type { PublicLawFind } from "@/components/public-law-table/use-public-law-find";
import { PropertyIcon } from "@/components/workspaces/property-helpers";
import type { TableFindColumnRow } from "@/components/workspaces/table/table-find-bar";
import type { Decision } from "@/features/case-law/components/decision-cells";
import type { DecisionTableLayout } from "@/features/case-law/decision-column-preferences.logic";
import {
  DECISION_COLUMN_IDS,
  decisionColumnLabelKey,
} from "@/features/case-law/decision-columns.logic";
import type {
  DecisionColumnId,
  DecisionReferenceColumnKind,
} from "@/features/case-law/decision-columns.logic";
import {
  decisionFindRowText,
  isFindableDecisionColumn,
  isFindableQuestionColumn,
} from "@/features/case-law/decision-find.logic";
import { DECISION_COLUMN_ICONS } from "@/features/case-law/decision-table-columns";
import {
  NO_QUESTION_COLUMNS,
  questionColumnId,
} from "@/features/case-law/research/question-columns.logic";
import type {
  QuestionAnswer,
  QuestionColumnSurface,
} from "@/features/case-law/research/question-columns.logic";

type UseDecisionFindOptions = {
  decisions: readonly Decision[];
  /** The arrangement: a column the reader hid is one a find must not reach. */
  layout: DecisionTableLayout;
  /** The pane a Cmd/Ctrl+F inside belongs to. */
  paneRef: RefObject<HTMLElement | null>;
  questions: QuestionColumnSurface;
  /** What the case-number column holds, so the find names it as the header does. */
  referenceKind: DecisionReferenceColumnKind;
  /** What the find belongs to: a jurisdiction, or a matter's mixed list. */
  surfaceKey: string;
};

const NO_ANSWERS: ReadonlyMap<string, QuestionAnswer> = new Map();

export const useDecisionFind = ({
  decisions,
  layout,
  paneRef,
  questions,
  referenceKind,
  surfaceKey,
}: UseDecisionFindOptions): PublicLawFind<Decision> => {
  const t = useTranslations();

  const questionColumns =
    questions.type === "available" ? questions.columns : NO_QUESTION_COLUMNS;
  // A reader without the question surface has no question columns either, so
  // nothing ever reads the empty map.
  const answersByKey =
    questions.type === "available" ? questions.answersByKey : NO_ANSWERS;
  const hidden = new Set(layout.hidden);
  const notSearchable = t("workspaces.views.findColumnNotSearchable");
  const columns: TableFindColumnRow[] = [];
  for (const column of DECISION_COLUMN_IDS) {
    if (hidden.has(column)) {
      continue;
    }
    columns.push({
      icon: <DecisionColumnIcon column={column} />,
      id: column,
      label: t(decisionColumnLabelKey(column, referenceKind)),
      ...(isFindableDecisionColumn(column)
        ? { searchable: true }
        : { reason: notSearchable, searchable: false }),
    });
  }
  for (const column of questionColumns) {
    const id = questionColumnId(column.id);
    if (hidden.has(id)) {
      continue;
    }
    columns.push({
      icon: <PropertyIcon type={column.content.type} />,
      id,
      label: column.question,
      ...(isFindableQuestionColumn(column)
        ? { searchable: true }
        : { reason: notSearchable, searchable: false }),
    });
  }

  return usePublicLawFind({
    columns,
    paneRef,
    rows: decisions,
    rowText: (decision) =>
      decisionFindRowText({ answersByKey, decision, questionColumns }),
    surfaceKey,
  });
};

const DecisionColumnIcon = ({ column }: { column: DecisionColumnId }) => {
  const Icon = DECISION_COLUMN_ICONS[column];
  return <Icon className="size-3.5 opacity-70" />;
};
