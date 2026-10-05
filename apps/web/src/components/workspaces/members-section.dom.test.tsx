import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register();
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});
const { render, cleanup, screen, fireEvent, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider, useQuery } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { MembersList } = await import("./members-section");
const { useQueryView } = await import("@/lib/use-query-view");

afterEach(cleanup);

test("member list shows an initial read error and retries before showing empty", async () => {
  const response = Promise.withResolvers<never>();
  let succeeded = false;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const readMembers = async () => (succeeded ? [] : await response.promise);
  const Read = () => {
    const view = useQueryView(
      useQuery({
        queryKey: ["members"],
        queryFn: readMembers,
      }),
    );
    return <MembersList view={view} canUpdate={false} workspaceId="matter" />;
  };
  render(
    <IntlProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <Read />
      </QueryClientProvider>
    </IntlProvider>,
  );
  expect(screen.getByRole("status").textContent).toBe(messages.common.loading);
  expect(
    screen.queryByText(messages.workspaces.members.noMembersFound),
  ).toBeNull();
  response.reject(new Error("Read unavailable"));
  await screen.findByRole("alert");
  expect(
    screen.queryByText(messages.workspaces.members.noMembersFound),
  ).toBeNull();
  succeeded = true;
  fireEvent.click(screen.getByRole("button", { name: messages.common.retry }));
  await waitFor(() =>
    expect(
      screen.getByText(messages.workspaces.members.noMembersFound),
    ).toBeTruthy(),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  client.clear();
});
