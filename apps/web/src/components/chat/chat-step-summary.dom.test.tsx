import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, jest, spyOn, test } from "bun:test";

import {
  CHAT_STEP_LEDGER_KEY,
  type ChatStepLedger,
} from "@stll/api-contract/chat-step-ledger";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { restoreRealTimers } from "@stll/property-testing/fake-timers";

import { testChatApprovalContextValue } from "@/components/chat/chat-approval-context.test-fixtures";
import {
  type PersistedChatMessage,
  projectCanonicalChatUIMessages,
} from "@/components/chat/chat-ui-tools";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => await Promise.resolve(Response.json(null)),
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: en } = await import("@/i18n/langs/en.json");
const { default: cs } = await import("@/i18n/langs/cs.json");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { ChatApprovalContext } =
  await import("@/components/chat/chat-approval-context");
const { ChatMattersContext } =
  await import("@/components/chat/chat-matters-context");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { ChatThreadMessages } =
  await import("@/components/chat/chat-thread-messages");

afterEach(async () => {
  await act(async () => cleanup());
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

type Part = PersistedChatMessage["parts"][number];

const QUESTION = {
  id: "question",
  parts: [{ type: "text", content: "Kdy začíná běžet lhůta k dovolání?" }],
  role: "user",
} satisfies PersistedChatMessage;

/** A code step with the ledger the server records beside it. */
const codeStep = (
  id: string,
  tools: readonly string[],
  state: "complete" | "input-complete" = "complete",
  typescriptCode = "return await run();",
): Part => {
  const input = { typescriptCode };
  const ledger = {
    calls: tools.map((tool) => ({
      tool,
      queries: ["počátek běhu lhůty k dovolání"],
      filters: [],
      outcome: "ok" as const,
      found: [],
      foundOmitted: 0,
    })),
    callsOmitted: 0,
  } satisfies ChatStepLedger;
  return {
    type: "tool-call",
    id,
    name: "execute_typescript",
    arguments: JSON.stringify(input),
    input,
    state,
    ...(state === "complete"
      ? { output: { success: true, logs: [], [CHAT_STEP_LEDGER_KEY]: ledger } }
      : {}),
  };
};

const READ_DOCUMENT = {
  type: "tool-call",
  id: "read",
  name: "read_document",
  arguments: "{}",
  input: {},
  state: "complete",
  output: { text: "11.3" },
} satisfies Part;
const FIND_TEXT = {
  type: "tool-call",
  id: "find",
  name: "find_text",
  arguments: "{}",
  input: {},
  state: "complete",
  output: { matches: [] },
} satisfies Part;
const REGISTRY_LOOKUP = {
  type: "tool-call",
  id: "registry",
  name: "business_registry_lookup",
  arguments: "{}",
  input: {},
  state: "complete",
  output: { company: {} },
} satisfies Part;

const ANSWER = {
  type: "text",
  content: "Lhůta běží od doručení rozhodnutí odvolacího soudu.",
} satisfies Part;

const LEGAL_RUN = [
  codeStep("search", ["search_case_law", "search_legislation"]),
  codeStep("read", ["read_statute_provisions", "read_case_law_decision"]),
  codeStep("more", ["search_case_law"]),
] satisfies Part[];

const Thread = ({
  isGenerating = false,
  locale = "en",
  parts,
  turnSentAt,
}: {
  isGenerating?: boolean;
  locale?: "cs" | "en";
  parts: Part[];
  turnSentAt?: number;
}) => (
  <ChatThreadTestRouter>
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider
        locale={locale}
        messages={locale === "cs" ? cs : en}
        timeZone="UTC"
      >
        <FormattingProvider locale={locale} timeZone="UTC">
          <ChatMattersContext
            value={{ createDocumentMattersView: { type: "empty" } }}
          >
            <ChatApprovalContext value={testChatApprovalContextValue}>
              <ChatEditorProvider>
                <ChatThreadMessages
                  activitySession={{
                    reportedUnknownActivityTypes: new Set<string>(),
                  }}
                  approvalPendingMessageId={null}
                  isGenerating={isGenerating}
                  messages={projectCanonicalChatUIMessages([
                    QUESTION,
                    { id: "answer", parts, role: "assistant" },
                  ])}
                  onAskUserSubmit={() => {}}
                  onCreateDocumentResolve={() => {}}
                  onOpenCreatedDocument={() => {}}
                  streamdownComponents={{
                    a: ({ children, ...props }) => <a {...props}>{children}</a>,
                  }}
                  turnSentAt={turnSentAt}
                />
              </ChatEditorProvider>
            </ChatApprovalContext>
          </ChatMattersContext>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>
  </ChatThreadTestRouter>
);

const stepTrigger = (container: HTMLElement): HTMLButtonElement => {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[data-slot="chat-step-list"] button',
  );
  if (trigger === null) {
    throw new Error("The run of steps draws no trigger");
  }
  return trigger;
};

test("a settled legal run says what it searched and how many lookups it took", () => {
  const view = render(<Thread parts={[...LEGAL_RUN, ANSWER]} />);
  expect(stepTrigger(view.container).textContent).toBe(
    "Searched legislation and case law · 5 lookups",
  );
  expect(view.container.textContent.toLowerCase()).not.toContain("analys");
});

/** The settled summary of a turn rendered on its own. */
const summaryOf = (parts: Part[], locale: "cs" | "en" = "en") => {
  const view = render(<Thread locale={locale} parts={[...parts, ANSWER]} />);
  const text = stepTrigger(view.container).textContent;
  view.unmount();
  return text;
};

test("the same run reads in Czech plurals", () => {
  expect(summaryOf(LEGAL_RUN, "cs")).toBe(
    "Prohledány předpisy a judikatura · 5 dotazů",
  );
  expect(
    summaryOf(
      [codeStep("one", ["search_case_law", "read_case_law_decision"])],
      "cs",
    ),
  ).toBe("Prohledána judikatura · 2 dotazy");
});

test("a run over matter work, the open document or the web names that instead", () => {
  expect(summaryOf([codeStep("matters", ["list_matters", "list_tasks"])])).toBe(
    "Looked through matters · 2 lookups",
  );
  expect(summaryOf([READ_DOCUMENT, FIND_TEXT])).toBe(
    "Read the document · 2 lookups",
  );
  expect(summaryOf([REGISTRY_LOOKUP])).toBe("Checked public registers");
});

test("a run that read and changed nothing counts its steps", () => {
  const view = render(
    <Thread
      parts={[
        { type: "thinking", content: "Which clause carries the cap?" },
        codeStep("compute", []),
        ANSWER,
      ]}
    />,
  );
  expect(stepTrigger(view.container).textContent).toBe("2 steps");
});

test("the summary is quiet text with a trailing chevron that opens the steps from the keyboard", () => {
  const view = render(<Thread parts={[...LEGAL_RUN, ANSWER]} />);
  const trigger = stepTrigger(view.container);
  const list = view.container.querySelector('[data-slot="chat-step-list"]');
  // No box around the line, closed or open.
  for (const node of [list, ...trigger.querySelectorAll("*")]) {
    expect(node?.className.toString() ?? "").not.toMatch(
      /(?:^|\s)(?:border|shadow-sm|bg-muted\/20|bg-background\/70)(?:\s|$)/u,
    );
  }
  // The chevron follows the words.
  const chevron = trigger.querySelector("svg");
  expect(chevron?.parentElement?.lastElementChild).toBe(chevron);
  expect(chevron?.parentElement?.firstElementChild).not.toBe(chevron);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  trigger.focus();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(list?.className.toString() ?? "").not.toMatch(
    /(?:^|\s)border(?:\s|$)/u,
  );
});

/** Fake timers drive the status line's tick; `performance.now()` follows. */
const withFakeClock = async (
  run: (clock: {
    now: number;
    advance: (ms: number) => Promise<void>;
  }) => Promise<void>,
) => {
  jest.useFakeTimers();
  const clock = {
    now: 1_000_000,
    advance: async (ms: number) => {
      clock.now += ms;
      await act(async () => {
        jest.advanceTimersByTime(ms);
      });
    },
  };
  const performanceNow = spyOn(performance, "now").mockImplementation(
    () => clock.now,
  );
  try {
    await run(clock);
  } finally {
    performanceNow.mockRestore();
    restoreRealTimers();
  }
};

test("a live run shows one line, naming its current step, with the clock after five seconds", async () => {
  await withFakeClock(async (clock) => {
    const view = render(
      <Thread
        isGenerating
        parts={[
          codeStep("search", ["search_case_law"]),
          // Still running, so it has no ledger yet: titled from its script.
          codeStep(
            "next",
            [],
            "input-complete",
            'await external_search_case_law({ queries: ["§ 240 o. s. ř."], country: "CZE" });',
          ),
        ]}
        turnSentAt={clock.now}
      />,
    );
    const lines = () =>
      view.container.querySelectorAll("[data-turn-live-status]");
    expect(lines()).toHaveLength(1);
    // The line is the run's own: no second label above or below it.
    const line = lines().item(0);
    expect(line.closest('[data-slot="chat-step-list"]')).not.toBeNull();
    expect(line.textContent).toBe(en.chat.toolCall.searchingCaseLaw);
    expect(stepTrigger(view.container).textContent).toBe(line.textContent);
    await clock.advance(4000);
    expect(lines().item(0).textContent).toBe(en.chat.toolCall.searchingCaseLaw);
    await clock.advance(2000);
    expect(lines().item(0).textContent).toBe(
      `${en.chat.toolCall.searchingCaseLaw}6s`,
    );
    await clock.advance(60_000);
    expect(lines().item(0).textContent).toBe(
      `${en.chat.toolCall.searchingCaseLaw}1 min`,
    );
  });
});

test("once the run hands over to the answer, the turn's line stands on its own again", () => {
  const view = render(<Thread isGenerating parts={[...LEGAL_RUN, ANSWER]} />);
  const lines = view.container.querySelectorAll("[data-turn-live-status]");
  expect(lines).toHaveLength(1);
  expect(lines.item(0).closest('[data-slot="chat-step-list"]')).toBeNull();
  expect(stepTrigger(view.container).textContent).toBe(
    "Searched legislation and case law · 5 lookups",
  );
});
