import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { queryView } from "@/lib/query-view.logic";

import { questionReads } from "./question-columns.logic";
import type { QuestionColumn, QuestionAnswer } from "./question-columns.logic";

const readError = new Error("Question read unavailable");

for (const site of Object.keys({
  columns: null,
  answers: null,
} satisfies Record<keyof Parameters<typeof questionReads>[0], null>)) {
  describe(`${site} read availability`, () => {
    test("a failed read is retryable and never a ready empty table", async () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const observer = new QueryObserver(client, {
        queryKey: ["question-reads", site],
        queryFn: async () => {
          throw readError;
        },
        enabled: false,
      });
      const failed = queryView(await observer.refetch());
      const empty = { type: "empty" } as const;
      const view = questionReads({
        columns: site === "columns" ? failed : empty,
        answers: site === "answers" ? failed : null,
      });
      expect(view.type).toBe("error");
      if (view.type === "error") {
        expect(view.error).toBe(readError);
        expect(view.retry).toBe(observer.getCurrentResult().refetch);
      }
      observer.destroy();
      client.clear();
    });

    test("cached empty data on failed refetch retains a notice", async () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const observer = new QueryObserver(client, {
        queryKey: ["question-reads", site, "cached"],
        initialData: [],
        queryFn: async () => {
          throw readError;
        },
        enabled: false,
      });
      const failed = queryView(await observer.refetch());
      const empty = { type: "empty" } as const;
      const view = questionReads({
        columns: site === "columns" ? failed : empty,
        answers: site === "answers" ? failed : null,
      });
      expect(view.type).toBe("ready");
      if (view.type === "ready") {
        expect(view.notice?.error).toBe(readError);
      }
      observer.destroy();
      client.clear();
    });
  });
}

test("pending reads are distinct from successful empty and disabled answers", () => {
  expect(
    questionReads({ columns: { type: "pending" }, answers: null }),
  ).toEqual({ type: "pending" });
  expect(
    questionReads({ columns: { type: "empty" }, answers: { type: "pending" } }),
  ).toEqual({
    type: "ready",
    columns: [],
    answers: [],
    answersStatus: "pending",
  });
  expect(questionReads({ columns: { type: "empty" }, answers: null })).toEqual({
    type: "ready",
    columns: [],
    answers: [],
    answersStatus: "ready",
  });
});

test("cached question columns and answers remain visible until their retry succeeds", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const columns = [
    {
      id: "notice-question",
      question: "Was notice served?",
      content: { version: 1, type: "text" },
    },
  ] as const satisfies readonly QuestionColumn[];
  const answers = [
    {
      columnId: "notice-question",
      decisionId: "decision-1",
      state: "answered",
      stale: false,
      answer: { version: 1, type: "text", value: "Notice was served." },
      failureReason: null,
    },
  ] as const satisfies readonly QuestionAnswer[];
  let outcome: "unavailable" | "available" = "unavailable";
  const readColumns = async () => {
    if (outcome === "unavailable") {
      throw readError;
    }
    return columns;
  };
  const readAnswers = async () => answers;
  const columnsObserver = new QueryObserver(client, {
    queryKey: ["question-columns", "cached-items"],
    initialData: columns,
    queryFn: readColumns,
    enabled: false,
  });
  const answersObserver = new QueryObserver(client, {
    queryKey: ["question-answers", "cached-items"],
    initialData: answers,
    queryFn: readAnswers,
    enabled: false,
  });
  const view = questionReads({
    columns: queryView(await columnsObserver.refetch()),
    answers: queryView(answersObserver.getCurrentResult()),
  });
  expect(view.type).toBe("ready");
  if (view.type === "ready") {
    expect(view.columns).toBe(columns);
    expect(view.answers).toBe(answers);
    expect(view.notice?.error).toBe(readError);
    outcome = "available";
    await view.notice?.retry();
    const recovered = questionReads({
      columns: queryView(columnsObserver.getCurrentResult()),
      answers: queryView(answersObserver.getCurrentResult()),
    });
    expect(recovered.type).toBe("ready");
    if (recovered.type === "ready") {
      expect(recovered.notice).toBeUndefined();
    }
  }
  columnsObserver.destroy();
  answersObserver.destroy();
  client.clear();
});

test("loaded columns remain visible while page answers load and runs wait", () => {
  const columns = [
    {
      id: "notice-question",
      question: "Was notice served?",
      content: { version: 1, type: "text" },
    },
  ] as const satisfies readonly QuestionColumn[];
  const client = new QueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ["question-columns", "pending-answers", columns],
    initialData: columns,
    queryFn: async () => columns,
    enabled: false,
  });
  const view = questionReads({
    columns: queryView(observer.getCurrentResult()),
    answers: { type: "pending" },
  });
  expect(view.type).toBe("ready");
  if (view.type === "ready") {
    expect(view.columns).toBe(columns);
    expect(view.answers).toEqual([]);
    expect(view.answersStatus).toBe("pending");
  }
  observer.destroy();
  client.clear();
});
