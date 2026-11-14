import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AddFactForm } = await import("./add-fact-form");
const messages = (await import("@/i18n/langs/en.json")).default;

const workspaceId = "0199a3c4-5b6d-7e8f-9a0b-000000009199";
const listId = "0199a3c4-5b6d-7e8f-9a0b-000000009198";
const originalFetch = globalThis.fetch;
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  for (const client of clients.splice(0)) {
    client.clear();
  }
});
afterAll(unregisterDomEnvironment);

type Sent = { key: string | null; capability: string | null; body: unknown };

/** Serves each task create from `answers` in order; reads answer empty. */
const serveCreates = (answers: Response[]) => {
  const sent: Sent[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method !== "PUT") {
        return Response.json({ items: [], nextCursor: null });
      }
      expect(new URL(request.url).pathname).toBe(`/v1/tasks/${workspaceId}`);
      sent.push({
        key: request.headers.get("Idempotency-Key"),
        capability: request.headers.get(CAPABILITY_REQUEST_HEADER),
        body: await request.json(),
      });
      return answers.shift() ?? Response.json({}, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return sent;
};

const Providers = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return (
    <IntlProvider locale="en" messages={messages}>
      <AuthenticatedUserProvider
        user={{
          id: "user-reviewer",
          activeOrganizationId: "org-reviewer",
          email: "reviewer@example.test",
          name: "Reviewer",
          image: null,
          preferredName: null,
          timezoneId: "UTC",
          wordEditShortcut: null,
        }}
      >
        <FormattingProvider locale="en" timeZone="UTC">
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </FormattingProvider>
      </AuthenticatedUserProvider>
    </IntlProvider>
  );
};

const addFact = (statement: string) => {
  fireEvent.change(
    screen.getByRole("textbox", { name: messages.avt.anchorFacts.addFact }),
    { target: { value: statement } },
  );
  fireEvent.click(screen.getByRole("button", { name: messages.common.add }));
};

test("a retried add replays under its first key and the next add gets a new one", async () => {
  const statement = "The drawdown occurred on 5 July 2021.";
  const sent = serveCreates([
    // The first attempt's response is lost.
    Response.json({ message: "Service unavailable" }, { status: 503 }),
    Response.json({ entityId: "0199a3c4-5b6d-7e8f-9a0b-000000009197" }),
    Response.json({ entityId: "0199a3c4-5b6d-7e8f-9a0b-000000009196" }),
  ]);
  render(
    <Providers>
      <AddFactForm
        workspaceId={workspaceId}
        listId={listId}
        onClose={() => undefined}
      />
    </Providers>,
  );

  addFact(statement);
  await waitFor(() => expect(sent).toHaveLength(1));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: messages.common.add,
      }).disabled,
    ).toBe(false),
  );
  // The input keeps the statement after a failure; the reviewer submits again.
  fireEvent.click(screen.getByRole("button", { name: messages.common.add }));
  await waitFor(() => expect(sent).toHaveLength(2));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: messages.avt.anchorFacts.addFact,
      }).value,
    ).toBe(""),
  );
  addFact(statement);
  await waitFor(() => expect(sent).toHaveLength(3));

  const [lost, retried, next] = sent;
  expect(lost?.key).toEqual(expect.any(String));
  expect(retried?.key).toBe(lost?.key ?? "");
  expect(next?.key).toEqual(expect.any(String));
  expect(next?.key).not.toBe(lost?.key ?? "");
  expect(sent.map(({ capability }) => capability)).toEqual([
    "tasks.create",
    "tasks.create",
    "tasks.create",
  ]);
  expect(sent.map(({ body }) => body)).toEqual([
    { name: statement, listId, listItemType: "fact" },
    { name: statement, listId, listItemType: "fact" },
    { name: statement, listId, listItemType: "fact" },
  ]);
});
