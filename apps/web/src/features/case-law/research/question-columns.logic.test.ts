import { describe, expect, test } from "bun:test";

import {
  answerNeedsRun,
  CASE_LAW_RESEARCH_ANSWER_STATES,
  CASE_LAW_RESEARCH_RUN_DECISIONS_MAX,
} from "@stll/api-contract";
import type { ResearchAnswerRunCheck } from "@stll/api-contract";
import { roles } from "@stll/permissions";

import {
  allowedColumnActions,
  answerKey,
  questionColumnSurface,
  READ_ONLY_QUESTIONS,
  questionEditDiscardsAnswers,
  questionRunSet,
  questionSuggestionBody,
  researchRunBatches,
  UNSEARCHED_SCOPE,
} from "./question-columns.logic";
import type {
  QuestionAnswer,
  QuestionColumn,
  QuestionColumnGrants,
  QuestionSuggestionScope,
} from "./question-columns.logic";

/**
 * A yes/no question, which the property model spells as a two-option select:
 * there is no boolean content type, and the null value a select already has is
 * the decision not settling the question.
 */
const YES_NO_CONTENT = {
  version: 1,
  type: "single-select",
  options: [
    { value: "yes", color: "green" },
    { value: "no", color: "red" },
  ],
  fallback: null,
} as const satisfies QuestionColumn["content"];

const TEXT_CONTENT = {
  version: 1,
  type: "text",
} as const satisfies QuestionColumn["content"];

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `d${index}`);

const column = (id: string): QuestionColumn => ({
  id,
  question: `question ${id}`,
  content: YES_NO_CONTENT,
});

const answer = (
  columnId: string,
  decisionId: string,
  state: QuestionAnswer["state"],
  stale = false,
): [string, QuestionAnswer] => [
  answerKey(columnId, decisionId),
  {
    columnId,
    decisionId,
    state,
    stale,
    answer:
      state === "answered"
        ? { version: 1, type: "single-select", value: "yes" }
        : null,
  },
];

const columns = [column("c1"), column("c2")];
const page = ["d1", "d2", "d3"];

describe("what a run covers", () => {
  test("an untouched page is every cell of it", () => {
    const runSet = questionRunSet({
      answersByKey: new Map(),
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: [],
    });

    expect(runSet.decisionIds).toEqual(page);
    expect(runSet.columnIds).toEqual(["c1", "c2"]);
    expect(runSet.cells).toBe(6);
  });

  test("a cell that already holds an answer is not asked again", () => {
    const runSet = questionRunSet({
      answersByKey: new Map([answer("c1", "d1", "answered")]),
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: [],
    });

    expect(runSet.cells).toBe(5);
    expect(runSet.decisionIds).toEqual(page);
  });

  test("a decision whose every cell is answered drops out of the run", () => {
    const runSet = questionRunSet({
      answersByKey: new Map([
        answer("c1", "d1", "answered"),
        answer("c2", "d1", "not_allowed"),
      ]),
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: [],
    });

    expect(runSet.decisionIds).toEqual(["d2", "d3"]);
    expect(runSet.cells).toBe(4);
  });

  /**
   * The count the reader confirms and the count the queue produces are one
   * policy, so a cell the server would skip is never billed in the estimate
   * and a cell it would retry is never left out of it.
   */
  test("a cell runs exactly when the queue's own policy says it does", () => {
    const cases = [
      // A failure is retried; a refusal is the source's terms, which a re-run
      // cannot change; an answer is the cache that makes paging back free.
      { state: "failed", stale: false },
      { state: "not_allowed", stale: false },
      { state: "answered", stale: false },
      // A live pending cell belongs to another run; a quiet one is a run that
      // died and may be claimed.
      { state: "pending", stale: false },
      { state: "pending", stale: true },
    ] as const satisfies readonly ResearchAnswerRunCheck[];

    expect(
      CASE_LAW_RESEARCH_ANSWER_STATES.every((state) =>
        cases.some((entry) => entry.state === state),
      ),
    ).toBe(true);

    for (const { stale, state } of cases) {
      const runSet = questionRunSet({
        answersByKey: new Map([answer("c1", "d1", state, stale)]),
        columnId: "c1",
        columns,
        pageDecisionIds: ["d1"],
        selectedDecisionIds: [],
      });

      expect(runSet.cells).toBe(answerNeedsRun({ state, stale }) ? 1 : 0);
    }
  });

  test("one column runs only its own cells", () => {
    const runSet = questionRunSet({
      answersByKey: new Map(),
      columnId: "c2",
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: [],
    });

    expect(runSet.columnIds).toEqual(["c2"]);
    expect(runSet.cells).toBe(3);
  });

  test("picking rows narrows the run to them", () => {
    const runSet = questionRunSet({
      answersByKey: new Map(),
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: ["d3", "d1"],
    });

    expect(runSet.decisionIds).toEqual(["d1", "d3"]);
    expect(runSet.cells).toBe(4);
  });

  test("a picked row that is not on this page is not run", () => {
    const runSet = questionRunSet({
      answersByKey: new Map(),
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: ["d2", "elsewhere"],
    });

    expect(runSet.decisionIds).toEqual(["d2"]);
    expect(runSet.cells).toBe(2);
  });

  /**
   * A selection outlives the rows it named: changing the query or a facet
   * redraws the page without clearing it. A selection none of whose rows
   * survived is not an empty run, it is no selection.
   */
  test("a selection the page no longer holds falls back to the page", () => {
    const runSet = questionRunSet({
      answersByKey: new Map(),
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: ["elsewhere"],
    });

    expect(runSet.decisionIds).toEqual(page);
    expect(runSet.cells).toBe(6);
  });

  test("an empty page has nothing to run, selection or not", () => {
    for (const selectedDecisionIds of [[], ["d1"]]) {
      expect(
        questionRunSet({
          answersByKey: new Map(),
          columns,
          pageDecisionIds: [],
          selectedDecisionIds,
        }),
      ).toEqual({ columnIds: ["c1", "c2"], decisionIds: [], cells: 0 });
    }
  });

  test("forcing asks every cell again", () => {
    const runSet = questionRunSet({
      answersByKey: new Map([
        answer("c1", "d1", "answered"),
        answer("c2", "d1", "answered"),
      ]),
      columns,
      force: true,
      pageDecisionIds: page,
      selectedDecisionIds: [],
    });

    expect(runSet.cells).toBe(6);
  });

  test("a run never covers more cells than rows times columns", () => {
    const states: QuestionAnswer["state"][] = [
      "answered",
      "pending",
      "failed",
      "not_allowed",
    ];
    for (const state of states) {
      const runSet = questionRunSet({
        answersByKey: new Map([answer("c1", "d2", state)]),
        columns,
        pageDecisionIds: page,
        selectedDecisionIds: [],
      });

      expect(runSet.cells).toBeLessThanOrEqual(page.length * columns.length);
      expect(runSet.decisionIds.length).toBeLessThanOrEqual(page.length);
    }
  });

  test("with no columns there is nothing to run", () => {
    const runSet = questionRunSet({
      answersByKey: new Map(),
      columns: [],
      pageDecisionIds: page,
      selectedDecisionIds: [],
    });

    expect(runSet).toEqual({ columnIds: [], decisionIds: [], cells: 0 });
  });
});

describe("how a run reaches the endpoint", () => {
  test("a page fits in one request", () => {
    expect(researchRunBatches([])).toEqual([]);
    expect(
      researchRunBatches(ids(CASE_LAW_RESEARCH_RUN_DECISIONS_MAX)),
    ).toHaveLength(1);
  });

  test("no batch is longer than the endpoint accepts", () => {
    for (const count of [1, 99, 100, 101, 250, 1000]) {
      for (const batch of researchRunBatches(ids(count))) {
        expect(batch.length).toBeGreaterThan(0);
        expect(batch.length).toBeLessThanOrEqual(
          CASE_LAW_RESEARCH_RUN_DECISIONS_MAX,
        );
      }
    }
  });

  test("the batches are the run set, in order and whole", () => {
    for (const count of [0, 1, 100, 101, 349]) {
      const decisionIds = ids(count);

      expect(researchRunBatches(decisionIds).flat()).toEqual(decisionIds);
    }
  });
});

describe("who is shown question columns", () => {
  const noop = () => undefined;
  const available = {
    answersByKey: new Map<string, QuestionAnswer>(),
    columns,
    addable: [],
    onAddToSearch: noop,
    grants: READ_ONLY_QUESTIONS,
    isRunning: false,
    onColumnAction: noop,
    onRetryAnswer: noop,
    onShowPassage: noop,
    suggestion: { ...UNSEARCHED_SCOPE, decisionIds: [] },
  };

  // What the results page passes: questions are authored there, so the
  // columns are read whether or not this search returned anything.
  test("a signed-in reader with an organization sees the results table's", () => {
    expect(
      questionColumnSurface({
        ...available,
        activeOrganizationId: "org_1",
        enabled: true,
      }),
    ).toEqual({ type: "available", ...available });
  });

  // The results page is public: a reader without an organization has no column
  // to read, and is still offered the way into writing one.
  test("a reader without an organization keeps the way into a question", () => {
    expect(
      questionColumnSurface({
        ...available,
        activeOrganizationId: null,
        enabled: true,
      }),
    ).toEqual({ type: "gated", suggestion: available.suggestion });
  });

  test("a matter with nothing linked asks nothing of anyone", () => {
    expect(
      questionColumnSurface({
        ...available,
        activeOrganizationId: "org_1",
        enabled: false,
      }),
    ).toEqual({ type: "hidden" });
  });

  // Reading the organization's answers is not a grant: a member it has not
  // licensed still gets the columns, and is offered nothing to change.
  test("a member without a grant still sees the columns", () => {
    expect(
      questionColumnSurface({
        ...available,
        activeOrganizationId: "org_1",
        enabled: true,
        grants: READ_ONLY_QUESTIONS,
      }).type,
    ).toBe("available");
  });
});

describe("what each role may do to a question column", () => {
  // Read out of the permission matrix rather than restated here, so a grant
  // moved between roles fails this test instead of drifting past it.
  const grantsFor = (role: keyof typeof roles): QuestionColumnGrants => ({
    create: roles[role].authorize({ caseLawResearch: ["create"] }).success,
    update: roles[role].authorize({ caseLawResearch: ["update"] }).success,
    delete: roles[role].authorize({ caseLawResearch: ["delete"] }).success,
    run: roles[role].authorize({ caseLawResearch: ["run"] }).success,
  });

  test.each(["owner", "admin", "member"] as const)(
    "%s authors, answers and removes",
    (role) => {
      const grants = grantsFor(role);

      expect(grants.create).toBe(true);
      expect(allowedColumnActions(grants)).toEqual([
        "edit",
        "run",
        "remove",
        "delete",
      ]);
    },
  );

  test.each(["intern", "external"] as const)(
    "%s reads the answers and may only take a question off the search",
    (role) => {
      const grants = grantsFor(role);

      expect(grants).toEqual(READ_ONLY_QUESTIONS);
      expect(allowedColumnActions(grants)).toEqual(["remove"]);
    },
  );

  test("a reader who may only ask again gets just that, beside the search", () => {
    expect(allowedColumnActions({ ...READ_ONLY_QUESTIONS, run: true })).toEqual(
      ["run", "remove"],
    );
  });
});

describe("what a suggestion request carries", () => {
  const scope: QuestionSuggestionScope = {
    country: "CZ",
    query: "náhrada škody",
    filters: {
      court: "Nejvyšší soud",
      decisionType: undefined,
      dateFrom: "2020-01-01",
      dateTo: undefined,
      language: undefined,
    },
    decisionIds: ids(9),
  };

  test("the search, the answer kind and its options", () => {
    expect(
      questionSuggestionBody({
        draft: {
          question: "  Byla žaloba zamítnuta?  ",
          content: YES_NO_CONTENT,
        },
        instruction: "Make it concise.",
        scope,
      }),
    ).toEqual({
      question: "Byla žaloba zamítnuta?",
      answerKind: "single-select",
      options: YES_NO_CONTENT.options,
      instruction: "Make it concise.",
      country: "CZ",
      query: "náhrada škody",
      filters: { court: "Nejvyšší soud", dateFrom: "2020-01-01" },
      decisionIds: ids(5),
    });
  });

  test("at most the sample allowance of decisions, and only their ids", () => {
    const body = questionSuggestionBody({
      draft: { question: "Which damages head?", content: TEXT_CONTENT },
      instruction: "Polish the writing.",
      scope,
    });

    expect(scope.decisionIds.length).toBeGreaterThan(body.decisionIds.length);
    expect(body.decisionIds).toEqual(scope.decisionIds.slice(0, 5));
    expect(Object.keys(body).toSorted()).toEqual([
      "answerKind",
      "country",
      "decisionIds",
      "filters",
      "instruction",
      "query",
      "question",
    ]);
  });

  test("a listing nobody searched for names no jurisdiction and no query", () => {
    const body = questionSuggestionBody({
      draft: { question: "Which damages head?", content: TEXT_CONTENT },
      instruction: "Polish the writing.",
      scope: { ...UNSEARCHED_SCOPE, decisionIds: ids(2) },
    });

    expect(body).toEqual({
      question: "Which damages head?",
      answerKind: "text",
      instruction: "Polish the writing.",
      filters: {},
      decisionIds: ids(2),
    });
  });
});

describe("when saving a question throws its answers away", () => {
  const stored = {
    question: "Was the termination valid?",
    content: YES_NO_CONTENT,
  } as const;

  test("adding a question has nothing to discard", () => {
    expect(
      questionEditDiscardsAnswers({ draft: { ...stored }, stored: undefined }),
    ).toBe(false);
  });

  test("saving an unchanged question keeps them", () => {
    expect(questionEditDiscardsAnswers({ draft: { ...stored }, stored })).toBe(
      false,
    );
  });

  // The server trims before it compares, so whitespace alone is not a change.
  test("whitespace around the same wording is not a change", () => {
    expect(
      questionEditDiscardsAnswers({
        draft: { ...stored, question: `  ${stored.question}\n` },
        stored,
      }),
    ).toBe(false);
  });

  test("rewording discards them", () => {
    expect(
      questionEditDiscardsAnswers({
        draft: { ...stored, question: "Was the notice period observed?" },
        stored,
      }),
    ).toBe(true);
  });

  test("a different kind of answer discards them", () => {
    expect(
      questionEditDiscardsAnswers({
        draft: { ...stored, content: { version: 1, type: "text" } },
        stored,
      }),
    ).toBe(true);
  });

  // An answer holding an option the column no longer offers is not an answer
  // any more, and the server drops the cells on any content change.
  test("dropping an option discards them", () => {
    expect(
      questionEditDiscardsAnswers({
        draft: {
          ...stored,
          content: {
            ...YES_NO_CONTENT,
            options: [{ value: "yes", color: "green" }],
          },
        },
        stored,
      }),
    ).toBe(true);
  });

  test("recolouring an option discards them", () => {
    expect(
      questionEditDiscardsAnswers({
        draft: {
          ...stored,
          content: {
            ...YES_NO_CONTENT,
            options: [
              { value: "yes", color: "green" },
              { value: "no", color: "orange" },
            ],
          },
        },
        stored,
      }),
    ).toBe(true);
  });

  // The stored content arrives from a JSONB column and the draft is built by
  // the composer, so the same options in the same order must compare equal
  // however either side happens to order its keys.
  test("the same options written in another key order keep them", () => {
    expect(
      questionEditDiscardsAnswers({
        draft: {
          ...stored,
          content: {
            fallback: null,
            options: [
              { color: "green", value: "yes" },
              { color: "red", value: "no" },
            ],
            type: "single-select",
            version: 1,
          },
        },
        stored,
      }),
    ).toBe(false);
  });
});
