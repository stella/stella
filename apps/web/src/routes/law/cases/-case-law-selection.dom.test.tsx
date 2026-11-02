import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Decision } from "@/features/case-law/components/decision-cells";
import { DEFAULT_DECISION_TABLE_LAYOUT } from "@/features/case-law/decision-column-preferences.logic";
import type { QuestionColumnSurface } from "@/features/case-law/research/question-columns.logic";
import { UNSEARCHED_SCOPE } from "@/features/case-law/research/question-columns.logic";
import de from "@/i18n/langs/de.json";
import en from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/api/auth/get-session")) {
      return Response.json(null);
    }
    return Response.json({});
  },
  { preconnect: originalFetch.preconnect },
);
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { useState } = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createRootRoute, createRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { DecisionTable } =
  await import("@/features/case-law/components/decision-table");
const { usePageSelection } = await import("./-case-law-page-selection");

afterEach(cleanup);
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const decisionIdentities = [
  ["decision-one", "12 C 1/2026"],
  ["decision-two", "18 C 2/2026"],
] as const;
const decisions = decisionIdentities.map(([id, caseNumber]): Decision => ({
  id,
  caseNumber,
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  citationCount: 0,
  country: "CZE",
  court: "Městský soud v Praze",
  decisionDate: "2026-01-14",
  decisionType: "rozsudek",
  decisionTypeKind: null,
  ecli: null,
  headnote: { type: "absent", reason: "not_published" },
  language: "cs",
  languageAlternates: [],
  slug: null,
}));

const question = {
  content: { version: 1, type: "text" },
  id: "outcome",
  question: "How did the court rule?",
} as const;
const noopSelectionRun = (_selectedIds: readonly string[]) => undefined;

/** What a new answer changes under a drawn table: its rows, or its page. */
type AnswerControls = {
  showPage: (page: number, rows: readonly Decision[]) => void;
};

const Fixture = ({
  locale = "en",
  messages = en,
  onRun = noopSelectionRun,
  onAnswerControls,
}: {
  locale?: "en" | "de";
  messages?: typeof en;
  onRun?: (selectedIds: readonly string[]) => void;
  onAnswerControls?: (controls: AnswerControls) => void;
}) => {
  const [answer, setAnswer] = useState<{
    page: number;
    rows: readonly Decision[];
  }>({ page: 1, rows: decisions });
  onAnswerControls?.({
    showPage: (page, rows) => setAnswer({ page, rows }),
  });
  const rowIds = answer.rows.map(({ id }) => id);
  const [selectedIds, setSelectedIds] = usePageSelection(answer.page, rowIds);
  const questions: QuestionColumnSurface = {
    type: "available",
    addable: [],
    addedIds: new Set(),
    answersByKey: new Map(),
    columns: [question],
    grants: { create: true, delete: true, run: true, update: true },
    isRunning: false,
    onAddToSearch: () => undefined,
    onColumnAction: () => undefined,
    onRetryAnswer: () => undefined,
    onRunColumn: () => undefined,
    onRunSelectedRows: () => onRun(selectedIds),
    onShowPassage: () => undefined,
    pageDecisionIds: rowIds,
    queuedAnswerKeys: new Set(),
    refusedAnswerKeys: new Set(),
    selectedDecisionIds: selectedIds,
    suggestion: {
      ...UNSEARCHED_SCOPE,
      decisionIds: rowIds,
    },
  };

  return (
    <IntlProvider locale={locale} messages={messages}>
      <FormattingProvider locale={locale} timeZone="UTC">
        <ActionCapabilitiesProvider
          value={{
            role: "member",
            capabilities: {
              ai: { type: "available" },
              deepl: { type: "available" },
              desktop: { type: "available" },
              legalLists: { type: "available" },
              ocr: { type: "available" },
              translation: { type: "available" },
              verification: { type: "available" },
            },
            documentOcr: undefined,
          }}
        >
          <QueryClientProvider client={new QueryClient()}>
            <DecisionTable
              dateOrder={null}
              decisions={answer.rows}
              firstRowNumber={1}
              isLoading={false}
              layout={DEFAULT_DECISION_TABLE_LAYOUT}
              onLayoutChange={() => undefined}
              onSelectedIdsChange={setSelectedIds}
              questions={questions}
              referenceKind="case-number"
              selectedIds={selectedIds}
            />
          </QueryClientProvider>
        </ActionCapabilitiesProvider>
      </FormattingProvider>
    </IntlProvider>
  );
};

const renderFixture = (props: ComponentProps<typeof Fixture> = {}) => {
  const rootRoute = createRootRoute();
  const caseRoute = createRoute({
    component: () => <Fixture {...props} />,
    getParentRoute: () => rootRoute,
    path: "/law/cases",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([caseRoute]),
  });
  return render(<RouterProvider router={router} />);
};

test("the selection action receives only selected decision ids and Clear empties its scope", async () => {
  const onRun = mock((_selectedIds: readonly string[]) => undefined);
  const view = renderFixture({ onRun });

  const checkbox = await waitFor(() =>
    view.getByRole("checkbox", { name: "Select 18 C 2/2026" }),
  );
  fireEvent.click(checkbox);
  expect(view.getByText("1 selected")).not.toBeNull();
  fireEvent.click(
    view.getByRole("button", { name: "Run AI columns for 1 row" }),
  );
  expect(onRun).toHaveBeenLastCalledWith(["decision-two"]);

  fireEvent.click(view.getByRole("button", { name: en.common.clearSelection }));
  expect(view.queryByText("1 selected")).toBeNull();
  expect(
    view.queryByRole("button", { name: "Run AI columns for 1 row" }),
  ).toBeNull();
  expect(onRun).toHaveBeenCalledTimes(1);

  fireEvent.click(view.getByRole("checkbox", { name: "Select 12 C 1/2026" }));
  fireEvent.click(
    view.getByRole("button", { name: "Run AI columns for 1 row" }),
  );
  expect(onRun).toHaveBeenLastCalledWith(["decision-one"]);
});

test("a new answer on the same page keeps only the picks it still shows", async () => {
  const onRun = mock((_selectedIds: readonly string[]) => undefined);
  let controls: AnswerControls | undefined;
  const view = renderFixture({
    onRun,
    onAnswerControls: (next) => {
      controls = next;
    },
  });

  fireEvent.click(
    await waitFor(() =>
      view.getByRole("checkbox", { name: en.common.selectAllRows }),
    ),
  );
  expect(view.getByText("2 selected")).not.toBeNull();

  const [decisionOne] = decisions;
  act(() =>
    controls?.showPage(1, decisionOne === undefined ? [] : [decisionOne]),
  );
  await waitFor(() => expect(view.getByText("1 selected")).not.toBeNull());
  fireEvent.click(
    view.getByRole("button", { name: "Run AI columns for 1 row" }),
  );
  expect(onRun).toHaveBeenLastCalledWith(["decision-one"]);

  act(() => controls?.showPage(1, []));
  await waitFor(() => expect(view.queryByText("1 selected")).toBeNull());
  act(() => controls?.showPage(1, decisions));
  expect(view.queryByText("1 selected")).toBeNull();
  expect(view.queryByText("2 selected")).toBeNull();
});

test("a step to another page clears the picks even when it shows the same rows", async () => {
  let controls: AnswerControls | undefined;
  const view = renderFixture({
    onAnswerControls: (next) => {
      controls = next;
    },
  });

  fireEvent.click(
    await waitFor(() =>
      view.getByRole("checkbox", { name: "Select 18 C 2/2026" }),
    ),
  );
  expect(view.getByText("1 selected")).not.toBeNull();
  act(() => controls?.showPage(2, decisions));
  await waitFor(() => expect(view.queryByText("1 selected")).toBeNull());
});

test("the header checkbox selects every decision on the page and the toolbar counts them", async () => {
  const onRun = mock((_selectedIds: readonly string[]) => undefined);
  const view = renderFixture({ onRun });

  const selectAll = await waitFor(() =>
    view.getByRole("checkbox", { name: en.common.selectAllRows }),
  );
  fireEvent.click(selectAll);
  expect(view.getByText("2 selected")).not.toBeNull();
  fireEvent.click(
    view.getByRole("button", { name: "Run AI columns for 2 rows" }),
  );
  expect(onRun).toHaveBeenLastCalledWith(["decision-one", "decision-two"]);
});

test.each([
  ["en", en, "Select 12 C 1/2026"],
  ["de", de, "12 C 1/2026 auswählen"],
] as const)(
  "row checkboxes use the case number in %s",
  async (locale, messages, name) => {
    const view = renderFixture({ locale, messages });

    await waitFor(() =>
      expect(view.getByRole("checkbox", { name })).not.toBeNull(),
    );
  },
);
