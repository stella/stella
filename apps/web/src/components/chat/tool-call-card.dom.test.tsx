import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

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
  await GlobalRegistrator.unregister();
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
