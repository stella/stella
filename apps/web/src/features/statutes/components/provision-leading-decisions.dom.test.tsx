import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const { render, cleanup, fireEvent, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider, useQuery } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { useQueryView } = await import("@/lib/use-query-view");
const { ProvisionLeadingDecisions } =
  await import("./provision-leading-decisions");
const messages = (await import("@/i18n/langs/en.json")).default;

afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

test("clicking retry recovers a selected read and replaces the error with content", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let readStatus: "unavailable" | "available" = "unavailable";
  let attempts = 0;
  const read = async () => {
    attempts += 1;
    if (readStatus === "unavailable") {
      throw new Error("Read unavailable");
    }
    return [];
  };
  const Read = () => {
    const view = useQueryView(
      useQuery({
        queryKey: ["provision-leading-decisions", "retry"],
        queryFn: read,
      }),
    );
    return (
      <ProvisionLeadingDecisions view={view}>
        <span>{messages.common.noResults}</span>
      </ProvisionLeadingDecisions>
    );
  };
  const screen = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <QueryClientProvider client={client}>
        <Read />
      </QueryClientProvider>
    </IntlProvider>,
  );
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
  expect(attempts).toBe(1);
  readStatus = "available";
  fireEvent.click(screen.getByRole("button", { name: messages.common.retry }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(attempts).toBe(2);
  expect(screen.getByText(messages.common.noResults)).toBeTruthy();
  cleanup();
  client.clear();
});
