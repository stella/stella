import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { CASE_LAW_RESEARCH_ANSWER_STATES } from "@stll/api-contract";
import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";

import type { QuestionAnswer } from "@/features/case-law/research/question-columns.logic";
import { FormattingProvider } from "@/i18n/formatting-context";
import arabicMessages from "@/i18n/langs/ar.json";
import messages from "@/i18n/langs/en.json";
import { resolveActionCapabilities } from "@/lib/organization/feature-access/action-capabilities.logic";
import { ActionCapabilitiesProvider } from "@/lib/organization/feature-access/capability-actions";

import { AiCell } from "./ai-cell";
import {
  propertyAiCellState,
  questionAiCellState,
} from "./ai-cell-state.logic";
import type { AiCellState } from "./ai-cell-state.logic";
import {
  AiColumnRunButton,
  AiColumnSelectionAction,
} from "./ai-column-run-controls";
import { AI_COLUMN_RUN_REVEAL, aiColumnRunScope } from "./ai-column-run.logic";

const states = {
  not_run: { type: "not_run" },
  queued: { type: "queued" },
  running: { type: "running" },
  done: { type: "done" },
  not_stated: { type: "not_stated" },
  failed: { type: "failed" },
  refused: { type: "refused", reason: "modelRefusal" },
  refused_budget: { type: "refused_budget" },
} as const satisfies Record<AiCellState["type"], AiCellState>;

const ANSWER_VALUE = "Answer value";

const expectedLabels = {
  not_run: "Not run",
  queued: "Queued",
  running: "Answering",
  done: "Answer value",
  not_stated: "Nothing found",
  failed: "Error",
  refused: "The model refused to answer",
  refused_budget: "answer budget unavailable",
} as const satisfies Record<AiCellState["type"], string>;

describe("every AI cell lifecycle state is visible", () => {
  for (const state of Object.values(states)) {
    test(state.type, () => {
      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <ActionCapabilitiesProvider
            value={resolveActionCapabilities({
              role: "member",
              ai: true,
              deepl: true,
              ocr: DOCUMENT_OCR_AVAILABILITY.live,
              desktop: "current",
              settings: undefined,
            })}
          >
            <IntlProvider locale="en" messages={messages} timeZone="UTC">
              <AiCell state={state}>{ANSWER_VALUE}</AiCell>
            </IntlProvider>
          </ActionCapabilitiesProvider>
        </QueryClientProvider>,
      );
      expect(html).toContain(`data-ai-cell-state="${state.type}"`);
      expect(html).toContain(expectedLabels[state.type]);
      if (state.type === "running" || state.type === "queued") {
        expect(html).toContain('role="status"');
        expect(html).toContain('aria-busy="true"');
        expect(html).toContain("<svg");
        expect(html).not.toContain("Answer value");
      }
    });
  }

  test("Arabic renders localized queue and running feedback", () => {
    for (const state of [states.queued, states.running]) {
      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <ActionCapabilitiesProvider
            value={resolveActionCapabilities({
              role: "member",
              ai: true,
              deepl: true,
              ocr: DOCUMENT_OCR_AVAILABILITY.live,
              desktop: "current",
              settings: undefined,
            })}
          >
            <IntlProvider locale="ar" messages={arabicMessages} timeZone="UTC">
              <AiCell state={state} />
            </IntlProvider>
          </ActionCapabilitiesProvider>
        </QueryClientProvider>,
      );
      expect(html).toContain(
        state.type === "queued"
          ? arabicMessages.common.queued
          : arabicMessages.caseLaw.research.answers.pending,
      );
      expect(html).not.toContain("Answering");
      expect(html).toContain('data-slot="loader"');
    }
  });

  test("streamed preview remains visible while the shared status spins", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ActionCapabilitiesProvider
          value={resolveActionCapabilities({
            role: "member",
            ai: true,
            deepl: true,
            ocr: DOCUMENT_OCR_AVAILABILITY.live,
            desktop: "current",
            settings: undefined,
          })}
        >
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <AiCell state={states.running} preview="Partial answer" />
          </IntlProvider>
        </ActionCapabilitiesProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain("Partial answer");
    expect(html).toContain('aria-busy="true"');
  });

  test("all research protocol states map deliberately, including licensing refusals", () => {
    const expected = {
      pending: "running",
      answered: "done",
      withdrawn: "done",
      not_stated: "done",
      not_allowed: "failed",
      failed: "failed",
    } as const satisfies Record<QuestionAnswer["state"], AiCellState["type"]>;
    for (const state of CASE_LAW_RESEARCH_ANSWER_STATES) {
      const answer = {
        columnId: "c",
        decisionId: "d",
        state,
        stale: false,
        answer: null,
        failureReason: state === "failed" ? "model_error" : null,
      } satisfies QuestionAnswer;
      expect(questionAiCellState({ answer }).type).toBe(expected[state]);
    }
    expect(questionAiCellState({ answer: undefined, queued: true }).type).toBe(
      "queued",
    );
    expect(
      questionAiCellState({ answer: undefined, refusedBudget: true }).type,
    ).toBe("refused_budget");
    expect(propertyAiCellState(undefined).type).toBe("not_run");
    expect(
      propertyAiCellState({
        aiSettlement: null,
        content: { version: 1, type: "pending" },
      }).type,
    ).toBe("running");
    expect(
      propertyAiCellState({
        aiSettlement: null,
        content: { version: 1, type: "error" },
      }).type,
    ).toBe("failed");
    expect(
      propertyAiCellState({
        aiSettlement: null,
        content: { version: 1, type: "text", value: "answer" },
      }).type,
    ).toBe("done");
    const metadata = { runId: "run-1", settledAt: "2026-10-28T00:00:00Z" };
    expect(
      propertyAiCellState({
        content: { version: 1, type: "unsupported" },
        aiSettlement: { ...metadata, type: "notStated" },
      }).type,
    ).toBe("not_stated");
    expect(
      propertyAiCellState({
        content: { version: 1, type: "unsupported" },
        aiSettlement: {
          ...metadata,
          type: "refused",
          reason: "modelRefusal",
        },
      }),
    ).toEqual({ type: "refused", reason: "modelRefusal" });
    expect(
      propertyAiCellState({
        content: { version: 1, type: "error" },
        aiSettlement: { ...metadata, type: "failed" },
      }).type,
    ).toBe("failed");
    expect(
      propertyAiCellState({
        content: { version: 1, type: "text", value: "answer" },
        aiSettlement: { ...metadata, type: "value" },
      }).type,
    ).toBe("done");
  });
});

describe("shared AI column controls", () => {
  test("header Play labels and tooltips name the actual page or selected row count", () => {
    for (const [selectedRowIds, label] of [
      [[], "Run for 3 rows on this page"],
      [["b"], "Run for 1 selected row"],
      [["a", "c"], "Run for 2 selected rows"],
    ] satisfies [string[], string][]) {
      const scope = aiColumnRunScope({
        pageRowIds: ["a", "b", "c"],
        selectedRowIds,
      });
      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <ActionCapabilitiesProvider
            value={resolveActionCapabilities({
              role: "member",
              ai: true,
              deepl: true,
              ocr: DOCUMENT_OCR_AVAILABILITY.live,
              desktop: "current",
              settings: undefined,
            })}
          >
            <IntlProvider locale="en" messages={messages} timeZone="UTC">
              <AiColumnRunButton
                scope={scope}
                reveal={AI_COLUMN_RUN_REVEAL.pinned}
                disabled={false}
                onRun={() => undefined}
              />
            </IntlProvider>
          </ActionCapabilitiesProvider>
        </QueryClientProvider>,
      );
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain("<svg");
      expect(html).toContain("data-base-ui-tooltip-trigger");
    }
  });
  test("the rendered selection bar states columns times rows and answer budget", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ActionCapabilitiesProvider
          value={resolveActionCapabilities({
            role: "member",
            ai: true,
            deepl: true,
            ocr: DOCUMENT_OCR_AVAILABILITY.live,
            desktop: "current",
            settings: undefined,
          })}
        >
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <FormattingProvider locale="en" timeZone="UTC">
              <AiColumnSelectionAction
                columns={3}
                rows={5}
                disabled={false}
                onRun={() => undefined}
              />
            </FormattingProvider>
          </IntlProvider>
        </ActionCapabilitiesProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain("Run AI columns for 5 rows");
    expect(html).toContain(
      "3 columns × 5 rows = 15 answers. Answers spend budget.",
    );
  });
});
