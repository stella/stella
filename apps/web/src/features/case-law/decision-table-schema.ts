/**
 * The column set of a table of decisions: the two utility columns every
 * workspace table has, the decision columns, and one column per question the
 * organization asks.
 *
 * The same descriptor shape a matter's table is built from, so the shell
 * arranges, hides, pins and resizes all three the same way; only the render
 * member says what a cell draws. Data rather than a renderer, so the column
 * set stays testable without drawing one.
 */

import { getInternalColId } from "@/components/workspaces/entity-utils";
import {
  ADD_PROPERTY_COLUMN_SIZE,
  DEFAULT_TABLE_COLUMN_MIN_SIZE,
  SELECT_COLUMN_SIZE,
  utilityColumn,
} from "@/components/workspaces/table/table-schema";
import type {
  WorkspaceColumnDescriptor,
  WorkspaceDecisionColumnRender,
  WorkspaceTableSchema,
} from "@/components/workspaces/table/table-schema";
import {
  DECISION_COLUMN_IDS,
  DECISION_COLUMN_MIN_SIZE,
  DECISION_COLUMN_MODEL,
} from "@/features/case-law/decision-columns.logic";
import type {
  DecisionExtraColumn,
  DecisionTableLabels,
} from "@/features/case-law/decision-columns.logic";
import { questionColumnId } from "@/features/case-law/research/question-columns.logic";
import type { QuestionColumn } from "@/features/case-law/research/question-columns.logic";

/** How wide a question column starts, before the reader drags it. */
const QUESTION_COLUMN_SIZE = 220;

export const NO_EXTRA_DECISION_COLUMNS: readonly DecisionExtraColumn[] = [];

export type DecisionTableSchemaParams = {
  /** Columns only this screen has, drawn after the questions. */
  extraColumns?: readonly DecisionExtraColumn[] | undefined;
  labels: DecisionTableLabels;
  /**
   * The organization's questions. Empty for a reader without one, which is
   * also why they get neither the add-column column nor a selection: nothing
   * on the page acts on a selection except a run.
   */
  questionColumns: readonly QuestionColumn[];
  /** Whether the reader may pick rows and add a question of their own. */
  withQuestionSurface: boolean;
};

export type DecisionTableSchema =
  WorkspaceTableSchema<WorkspaceDecisionColumnRender>;

export type DecisionColumnDescriptor =
  WorkspaceColumnDescriptor<WorkspaceDecisionColumnRender>;

export const decisionTableSchema = ({
  extraColumns = NO_EXTRA_DECISION_COLUMNS,
  labels,
  questionColumns,
  withQuestionSurface,
}: DecisionTableSchemaParams): DecisionTableSchema => {
  const columns: DecisionColumnDescriptor[] = [
    utilityColumn({
      id: getInternalColId("select"),
      size: SELECT_COLUMN_SIZE,
      render: { type: "select" },
      pin: true,
    }),
  ];

  for (const column of DECISION_COLUMN_IDS) {
    const model = DECISION_COLUMN_MODEL[column];
    columns.push({
      id: column,
      label: labels[column],
      render: { type: "decision", column },
      size: model.size,
      minSize: DECISION_COLUMN_MIN_SIZE,
      capabilities: {
        // Decisions are ordered by the search, never by a column.
        sort: false,
        hide: model.hide,
        resize: true,
        pin: true,
      },
      emphasis: model.emphasis,
    });
  }

  for (const column of questionColumns) {
    columns.push({
      id: questionColumnId(column.id),
      label: column.question,
      render: { type: "question", column },
      size: QUESTION_COLUMN_SIZE,
      minSize: DECISION_COLUMN_MIN_SIZE,
      capabilities: { sort: false, hide: true, resize: true, pin: true },
      emphasis: "content",
    });
  }

  for (const column of extraColumns) {
    columns.push({
      id: column.id,
      label: column.label,
      render: { type: "decision-extra", column },
      size: column.size,
      minSize: DECISION_COLUMN_MIN_SIZE,
      capabilities: { sort: false, hide: true, resize: true, pin: true },
      emphasis: "content",
    });
  }

  if (withQuestionSurface) {
    columns.push(
      utilityColumn({
        id: getInternalColId("add-property"),
        size: ADD_PROPERTY_COLUMN_SIZE,
        render: { type: "add-property" },
        pin: false,
      }),
    );
  }

  return { columns, defaultMinSize: DEFAULT_TABLE_COLUMN_MIN_SIZE };
};
