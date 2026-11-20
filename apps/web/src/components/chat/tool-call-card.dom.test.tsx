import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/ar.json" with { type: "json" };
import csMessages from "@/i18n/langs/cs.json" with { type: "json" };
import enMessages from "@/i18n/langs/en.json" with { type: "json" };

import type { StepFailureOutcome } from "./tool-call-card";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ToolCallCard } = await import("./tool-call-card");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("tool duration respects the selected numbering system", () => {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="ar" messages={messages}>
        <FormattingProvider locale="ar-u-nu-arab" timeZone="UTC">
          <ToolCallCard
            activeOrganizationId="test-org"
            failureOutcome="terminal"
            durationMs={2000}
            part={{
              type: "tool-call",
              id: "completed-search",
              name: "search-chat-history",
              arguments: '{"query":"synthetic"}',
              input: { query: "synthetic" },
              output: { query: "synthetic", results: [] },
              state: "complete",
            }}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  expect(screen.getByText(/٢/u)).toBeDefined();
  expect(screen.queryByText(/2/u)).toBeNull();
});

test("a running tool is not announced as waiting", () => {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="ar" messages={messages}>
        <FormattingProvider locale="ar-u-nu-arab" timeZone="UTC">
          <ToolCallCard
            activeOrganizationId="test-org"
            failureOutcome="terminal"
            part={{
              type: "tool-call",
              id: "running-search",
              name: "search-chat-history",
              arguments: '{"query":"synthetic"}',
              input: { query: "synthetic" },
              state: "input-complete",
            }}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  expect(
    screen.queryByLabelText(messages.chat.toolCall.statusWaiting),
  ).toBeNull();
});

test("a call its turn cut off reads as stopped, not as a failure", () => {
  const queryClient = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="ar" messages={messages}>
        <FormattingProvider locale="ar-u-nu-arab" timeZone="UTC">
          <ToolCallCard
            activeOrganizationId="test-org"
            failureOutcome="terminal"
            part={{
              type: "tool-call",
              id: "stopped-search",
              name: "search-chat-history",
              arguments: '{"query":"synthetic"}',
              input: { query: "synthetic" },
              state: "error",
            }}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  expect(container.innerHTML.includes(messages.chat.toolCall.interrupted)).toBe(
    true,
  );
  expect(container.innerHTML.includes("bg-destructive")).toBe(false);
});

test("a connector call that failed with a plain-text error reads as failed, not as stopped", () => {
  const queryClient = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="ar" messages={messages}>
        <FormattingProvider locale="ar-u-nu-arab" timeZone="UTC">
          <ToolCallCard
            activeOrganizationId="test-org"
            failureOutcome="terminal"
            part={{
              type: "tool-call",
              id: "failed-connector",
              name: "mcp__synthetic__lookup",
              arguments: '{"query":"synthetic"}',
              input: { query: "synthetic" },
              output: "Connection refused.",
              state: "error",
            }}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  expect(container.innerHTML.includes(messages.chat.toolCall.failed)).toBe(
    true,
  );
  expect(container.innerHTML.includes(messages.chat.toolCall.interrupted)).toBe(
    false,
  );
});

test("a coding agent's step its turn cut off reads as stopped, not as failed", () => {
  const queryClient = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="ar" messages={messages}>
        <FormattingProvider locale="ar-u-nu-arab" timeZone="UTC">
          <ToolCallCard
            activeOrganizationId="test-org"
            failureOutcome="terminal"
            part={{
              type: "tool-call",
              id: "stopped-command",
              name: "command_execution",
              arguments: '{"command":"bun test"}',
              input: { command: "bun test" },
              output: { status: "interrupted" },
              state: "error",
            }}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  expect(container.innerHTML.includes(messages.chat.toolCall.interrupted)).toBe(
    true,
  );
  expect(container.innerHTML.includes("bg-destructive")).toBe(false);
});

test("a coding agent's step that reports it failed reads as failed, not as stopped", () => {
  const queryClient = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="ar" messages={messages}>
        <FormattingProvider locale="ar-u-nu-arab" timeZone="UTC">
          <ToolCallCard
            activeOrganizationId="test-org"
            failureOutcome="terminal"
            part={{
              type: "tool-call",
              id: "failed-command",
              name: "command_execution",
              arguments: '{"command":"bun test"}',
              input: { command: "bun test" },
              output: { status: "failed" },
              state: "error",
            }}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  expect(container.innerHTML.includes(messages.chat.toolCall.failed)).toBe(
    true,
  );
  expect(container.innerHTML.includes(messages.chat.toolCall.interrupted)).toBe(
    false,
  );
  // Only the status mark says so; the row keeps the step colours.
  expect(container.innerHTML.includes("bg-destructive")).toBe(false);
});

type StepPart = ComponentProps<typeof ToolCallCard>["part"];

const renderStep = ({
  failureOutcome = "terminal",
  locale,
  part,
}: {
  failureOutcome?: StepFailureOutcome;
  locale: "cs" | "en";
  part: StepPart;
}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider
        locale={locale}
        messages={locale === "cs" ? csMessages : enMessages}
      >
        <FormattingProvider locale={locale} timeZone="UTC">
          <ToolCallCard
            activeOrganizationId="test-org"
            failureOutcome={failureOutcome}
            part={part}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

const codeStep = (typescriptCode: string): StepPart => ({
  type: "tool-call",
  id: "completed-code",
  name: "execute_typescript",
  arguments: JSON.stringify({ typescriptCode }),
  input: { typescriptCode },
  output: { logs: [], result: "{}", success: true },
  state: "complete",
});

const SECTION_ERROR = "Section 11.2 was renumbered in this version.";

const failedSectionRead = (): StepPart => ({
  type: "tool-call",
  id: "failed-section",
  name: "read_section",
  arguments: JSON.stringify({ section: "11.2" }),
  input: { section: "11.2" },
  output: { error: SECTION_ERROR },
  state: "complete",
});

// A tool name, an input key or a script function: plumbing, never copy.
const SNAKE_CASE = /\b[a-z]+_[a-z0-9_]+\b/u;

const expectHumanRow = (text: string | null) => {
  expect(text).not.toBeNull();
  expect(SNAKE_CASE.test(text ?? "")).toBe(false);
  expect(/characters|znaků|znaky/u.test(text ?? "")).toBe(false);
};

const CASE_LAW_SEARCH =
  'const r = await external_search_case_law({country:"CZE", queries:["předseda senátu odmítl dovolání","§ 243c odst. 2 o. s. ř. předseda senátu"], limit:15});\nreturn JSON.stringify(r).slice(0,9000);';
const STATUTE_READS =
  'const s = await external_search_legislation({country:"CZE", query:"občanský soudní řád"});\nconst s2 = await external_read_statute_provisions({items:[{eli:"https://www.e-sbirka.cz/eli/cz/sb/1963/99",anchor:"par_240"}]});\nreturn JSON.stringify({s, s2});';
const MIXED_RESEARCH =
  'const r = await external_search_case_law({country:"CZE", queries:["II. ÚS 849/16"]});\nconst s = await external_search_legislation({country:"CZE", query:"99/1963 Sb."});\nconst t = await external_read_case_law_decision({decision_ids:["f46d5994"]});';
const WORKSPACE_READ =
  "const m = await external_list_matters({limit:5});\nreturn JSON.stringify(m);";

describe("a step names the legal action, not the mechanism", () => {
  test("choosing tools names what the step is for, without the tool names", () => {
    const { container } = renderStep({
      locale: "en",
      part: {
        type: "tool-call",
        id: "completed-discover",
        name: "discover_tools",
        arguments: JSON.stringify({
          toolNames: [
            "external_search_case_law",
            "external_search_legislation",
          ],
        }),
        input: {
          toolNames: [
            "external_search_case_law",
            "external_search_legislation",
          ],
        },
        output: { tools: [] },
        state: "complete",
      },
    });

    expect(screen.getByText(enMessages.chat.tool.discover_tools)).toBeDefined();
    expect(container.textContent.includes("search")).toBe(false);
    expectHumanRow(container.textContent);
  });

  test.each([
    {
      code: CASE_LAW_SEARCH,
      subtitle: "§ 243c odst. 2 o. s. ř.",
      title: enMessages.chat.toolCall.searchingCaseLaw,
    },
    {
      code: STATUTE_READS,
      subtitle: "občanský soudní řád · 2 lookups",
      title: enMessages.chat.toolCall.readingLegislation,
    },
    {
      code: MIXED_RESEARCH,
      subtitle: "II. ÚS 849/16 · 3 lookups",
      title: enMessages.chat.toolCall.searchingLegislationAndCaseLaw,
    },
    {
      code: WORKSPACE_READ,
      subtitle: undefined,
      title: enMessages.chat.tool.execute_typescript,
    },
  ])("a code run reads as $title", ({ code, subtitle, title }) => {
    const { container } = renderStep({ locale: "en", part: codeStep(code) });

    expect(screen.getByText(title)).toBeDefined();
    if (subtitle !== undefined) {
      expect(screen.getByText(subtitle)).toBeDefined();
    }
    expectHumanRow(container.textContent);
  });

  test("a Czech row names the research and counts lookups in Czech", () => {
    const { container } = renderStep({
      locale: "cs",
      part: codeStep(STATUTE_READS),
    });

    expect(
      screen.getByText(csMessages.chat.toolCall.readingLegislation),
    ).toBeDefined();
    expect(screen.getByText("občanský soudní řád · 2 dotazy")).toBeDefined();
    expectHumanRow(container.textContent);
  });

  test("every step title the catalogue holds is written for people", () => {
    for (const [key, title] of Object.entries(enMessages.chat.tool)) {
      expect({ key, snakeCase: SNAKE_CASE.test(title) }).toEqual({
        key,
        snakeCase: false,
      });
    }
  });
});

describe("a finished step sits on the rail; only live and failed steps draw a mark", () => {
  test("a finished step draws no mark and still names its status", () => {
    const { container } = renderStep({
      locale: "en",
      part: codeStep(CASE_LAW_SEARCH),
    });

    expect(container.querySelector('[data-slot="status-mark"]')).toBeNull();
    expect(screen.getByText(enMessages.common.done)).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: new RegExp(enMessages.chat.toolCall.searchingCaseLaw, "u"),
      }),
    ).toBeDefined();
  });

  test("a running step draws its mark", () => {
    const { container } = renderStep({
      locale: "en",
      part: {
        type: "tool-call",
        id: "running-code",
        name: "execute_typescript",
        arguments: JSON.stringify({ typescriptCode: CASE_LAW_SEARCH }),
        input: { typescriptCode: CASE_LAW_SEARCH },
        state: "input-complete",
      },
    });

    expect(container.querySelector('[data-slot="status-mark"]')).not.toBeNull();
  });

  test("a failed step draws its mark with an accessible name", () => {
    renderStep({ locale: "en", part: failedSectionRead() });

    expect(
      screen.getByRole("img", { name: enMessages.chat.toolCall.failed }),
    ).toBeDefined();
  });
});

describe("a failed step stays calm when its turn went on past it", () => {
  test("a recovered failure reads as retried, with the reason behind its disclosure", () => {
    const { container } = renderStep({
      failureOutcome: "recovered",
      locale: "cs",
      part: failedSectionRead(),
    });

    expect(screen.getByText(csMessages.chat.toolCall.retried)).toBeDefined();
    expect(container.innerHTML.includes("destructive")).toBe(false);
    expect(
      container.textContent.includes(csMessages.chat.toolCall.failed),
    ).toBe(false);
    expect(
      container.textContent.includes(csMessages.chat.toolCall.retriedDetail),
    ).toBe(false);
    expect(container.textContent.includes(SECTION_ERROR)).toBe(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: csMessages.chat.toolCall.toggleDetails,
      }),
    );

    expect(
      screen.getByText(csMessages.chat.toolCall.retriedDetail),
    ).toBeDefined();
    // The raw error was written for the model; only the technical details
    // setting shows it.
    expect(container.textContent.includes(SECTION_ERROR)).toBe(false);
  });

  test("a failure that ended the turn is named by its mark alone, in the step colours", () => {
    const { container } = renderStep({
      failureOutcome: "terminal",
      locale: "cs",
      part: failedSectionRead(),
    });

    // The mark keeps the failure colour and its accessible name; the row,
    // its title and its body draw none, and no line under it repeats it.
    expect(
      screen.getByRole("img", { name: csMessages.chat.toolCall.failed }),
    ).toBeDefined();
    expect(
      container.textContent.includes(csMessages.chat.toolCall.failed),
    ).toBe(false);
    expect(container.innerHTML.includes("bg-destructive")).toBe(false);
    expect(
      container.querySelectorAll(
        '.text-destructive:not([data-slot="status-mark"])',
      ),
    ).toHaveLength(0);
    expect(screen.queryByText(csMessages.chat.toolCall.retried)).toBeNull();
  });
});
