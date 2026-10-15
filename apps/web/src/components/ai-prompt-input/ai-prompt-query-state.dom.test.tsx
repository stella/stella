import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/prompt" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { cleanup, render, waitFor, fireEvent, act } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { AIPromptInput } = await import("./ai-prompt-input");
const { skillsOptions } = await import("@/lib/knowledge/queries");
const messages = (await import("@/i18n/langs/en.json")).default;
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});
const mount = (client: InstanceType<typeof QueryClient>) =>
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "org",
            id: "user",
            email: "user@example.test",
            image: null,
            name: "User",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <AIPromptInput
            value="Instruction"
            valueFormat="text"
            onChange={() => undefined}
            skillChips="caller"
          />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

test("prompt skill read exposes pending and retry without removing the editable instruction", async () => {
  const pending = Promise.withResolvers<Response>();
  let attempts = 0;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/skills")) {
        attempts += 1;
        return attempts === 1
          ? pending.promise
          : Response.json({
              builtIn: [],
              installed: [],
              canManageTeam: false,
              limit: 100,
              nextCursor: null,
            });
      }
      return Response.json({ unavailable: [] });
    },
    { preconnect: () => undefined },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const screen = mount(client);
  expect(screen.queryByRole("status")).not.toBeNull();
  expect(screen.getByText("Instruction")).toBeTruthy();
  await act(async () => {
    pending.resolve(
      Response.json({ message: "Read unavailable" }, { status: 503 }),
    );
  });
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: messages.common.retry }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(attempts).toBe(2);
  expect(screen.getByText("Instruction")).toBeTruthy();
});

test("prompt skill read retains the editor and reports a failed refresh of cached empty pages", async () => {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.pathname.endsWith("/skills")
        ? Response.json({ message: "Read unavailable" }, { status: 503 })
        : Response.json({ unavailable: [] });
    },
    { preconnect: () => undefined },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const options = skillsOptions("org", "user");
  client.setQueryData(options.queryKey, {
    pages: [
      {
        builtIn: [],
        installed: [],
        canManageTeam: false,
        limit: 100,
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  const screen = mount(client);
  await act(async () => {
    await client.invalidateQueries({ queryKey: options.queryKey });
  });
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
  expect(screen.getByText("Instruction")).toBeTruthy();
});
