import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/ar.json" with { type: "json" };

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, render, screen } = await import("@testing-library/react");
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
