/**
 * Find-in-table over decision rows.
 *
 * The shell's bar, the shell's resolution, the shell's marks; what this adds
 * is the decision half — which columns a find can reach, the text each shows,
 * and where the find is kept. It is kept in page state rather than stored: a
 * find is a question about the rows in front of the reader, and a public page
 * has no account to hang one on anyway.
 */

import { useState } from "react";
import type { ComponentProps, RefObject } from "react";

import { useTranslations } from "use-intl";

import { PropertyIcon } from "@/components/workspaces/property-helpers";
import type { TableFindHighlight } from "@/components/workspaces/table/find-highlight";
import type {
  TableFindBar,
  TableFindColumnRow,
} from "@/components/workspaces/table/table-find-bar";
import {
  resolveTableFind,
  UNRESTRICTED_FIND,
} from "@/components/workspaces/table/table-find.logic";
import type {
  TableFindPersistence,
  TableFindState,
} from "@/components/workspaces/table/table-find.logic";
import type { Decision } from "@/features/case-law/components/decision-cells";
import type { DecisionTableLayout } from "@/features/case-law/decision-column-preferences.logic";
import {
  DECISION_COLUMN_IDS,
  DECISION_COLUMN_LABEL_KEYS,
} from "@/features/case-law/decision-columns.logic";
import type { DecisionColumnId } from "@/features/case-law/decision-columns.logic";
import {
  findDecisions,
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
  /** What the find belongs to: a jurisdiction, or a matter's mixed list. */
  surfaceKey: string;
};

export type DecisionFind = {
  /** Everything the shared bar is drawn from. */
  bar: ComponentProps<typeof TableFindBar>;
  /** The rows the find leaves on screen. */
  decisions: readonly Decision[];
  highlight: TableFindHighlight | null;
};

export const useDecisionFind = ({
  decisions,
  layout,
  paneRef,
  questions,
  surfaceKey,
}: UseDecisionFindOptions): DecisionFind => {
  const t = useTranslations();
  const [state, setState] = useState<TableFindState | undefined>(undefined);
  // A find belongs to the list it was typed over. Switching jurisdictions
  // gives a different corpus, so the term does not follow; adjusting during
  // render is the sanctioned reset, and the bar reads the new state.
  const [findFor, setFindFor] = useState(surfaceKey);
  if (findFor !== surfaceKey) {
    setFindFor(surfaceKey);
    setState(undefined);
  }

  const questionColumns =
    questions.type === "available" ? questions.columns : NO_QUESTION_COLUMNS;
  const answersByKey =
    questions.type === "available"
      ? questions.answersByKey
      : // A reader without the question surface has no question columns either,
        // so nothing ever reads this.
        new Map<string, QuestionAnswer>();
  const hidden = new Set(layout.hidden);
  const notSearchable = t("workspaces.views.findColumnNotSearchable");
  const columns: TableFindColumnRow[] = [];
  for (const column of DECISION_COLUMN_IDS) {
    // Hidden columns are left out entirely: a row that matched only in a
    // column the reader cannot see would show no mark and read as a bug.
    if (hidden.has(column)) {
      continue;
    }
    columns.push({
      icon: <DecisionColumnIcon column={column} />,
      id: column,
      label: t(DECISION_COLUMN_LABEL_KEYS[column]),
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

  const resolved = resolveTableFind({
    columns,
    // A decision row has no name column: every string it shows belongs to a
    // column of its own.
    hasNameColumn: false,
    selection: state?.scope ?? UNRESTRICTED_FIND,
    term: state?.submitted ?? "",
  });

  const find: TableFindPersistence = {
    clear: () => {
      setState(undefined);
    },
    close: () => {
      setState((current) =>
        current === undefined ? current : { ...current, status: "closed" },
      );
    },
    key: surfaceKey,
    open: () => {
      setState((current) =>
        current === undefined ? OPENED_FIND : { ...current, status: "open" },
      );
    },
    setScope: (scope) => {
      setState((current) =>
        current === undefined ? current : { ...current, scope },
      );
    },
    setTyped: (typed) => {
      setState((current) =>
        current === undefined ? current : { ...current, typed },
      );
    },
    state,
    submit: () => {
      setState((current) =>
        current === undefined
          ? current
          : { ...current, submitted: current.typed },
      );
    },
  };

  return {
    bar: {
      appliedTerm: resolved.term,
      columns,
      find,
      paneRef,
      selection: resolved.selection,
    },
    decisions: findDecisions({
      answersByKey,
      columnIds: resolved.columnIds,
      decisions,
      questionColumns,
      term: resolved.term,
    }),
    highlight: resolved.highlight,
  };
};

/** A find that has only just been opened: the bar is up, nothing is typed. */
const OPENED_FIND: TableFindState = {
  scope: UNRESTRICTED_FIND,
  status: "open",
  submitted: "",
  typed: "",
};

const DecisionColumnIcon = ({ column }: { column: DecisionColumnId }) => {
  const Icon = DECISION_COLUMN_ICONS[column];
  return <Icon className="size-3.5 opacity-70" />;
};
