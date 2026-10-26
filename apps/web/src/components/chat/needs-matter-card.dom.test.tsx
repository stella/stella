import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import type { RegisteredChatUIToolCallPart } from "@/components/chat/chat-ui-tools";
import type { NeedsMatterMatter } from "@/components/chat/needs-matter-card";
import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const fetch = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(async () => Response.json({}), {
    preconnect: globalThis.fetch.preconnect,
  }),
);
const { act } = await import("react");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider, useQuery } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { useQueryView } = await import("@/lib/use-query-view");
const { ChatMattersContext } = await import("./chat-matters-context");
const { NeedsMatterCard } = await import("./needs-matter-card");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  fetch.mockRestore();
  await unregisterDomEnvironment();
});

const part = {
  type: "tool-call",
  name: "create-document",
  id: "draft-tool",
  state: "complete",
  arguments: "{}",
  input: { name: "Draft", source: "@doc kind=other locale=en page=A4" },
  output: { success: true, destination: "draft", fileName: "Draft.docx" },
} satisfies RegisteredChatUIToolCallPart;

const matter = {
  id: "matter-1",
  name: "Matter one",
  color: null,
  client: null,
} satisfies NeedsMatterMatter;
const queryKey = ["needs-matter-picker-test"];

const mountPicker = (
  queryFn: () => Promise<NeedsMatterMatter[]>,
  cached?: NeedsMatterMatter[],
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  if (cached) {
    client.setQueryData(queryKey, cached);
  }
  const Picker = () => {
    const query = useQuery({ queryKey, queryFn });
    const value = {
      createDocumentMattersView: useQueryView(query),
    };
    return (
      <ChatMattersContext value={value}>
        <NeedsMatterCard
          part={part}
          onResolve={() => {}}
          onOpenCreated={() => {}}
        />
      </ChatMattersContext>
    );
  };
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Picker />
      </IntlProvider>
    </QueryClientProvider>,
  );
};

test("failed matter reads show retry instead of the empty matter message, then recover", async () => {
  const pending = Promise.withResolvers<NeedsMatterMatter[]>();
  let calls = 0;
  const view = mountPicker(async () => {
    calls += 1;
    return calls === 1 ? pending.promise : Promise.resolve([matter]);
  });
  expect(view.getByText(messages.common.loading)).toBeDefined();
  await act(async () => pending.reject(new Error("matter read failed")));
  await waitFor(() => expect(view.queryByRole("alert")).not.toBeNull());
  expect(view.queryByText(messages.inspector.matterPicker.empty)).toBeNull();
  fireEvent.click(view.getByRole("button", { name: messages.common.retry }));
  await waitFor(() =>
    expect(view.getByRole("button", { name: matter.name })).toBeDefined(),
  );
  expect(calls).toBe(2);
  expect(view.queryByRole("alert")).toBeNull();
});

test("failed matter refetches keep cached choices and a retry notice", async () => {
  const pending = Promise.withResolvers<NeedsMatterMatter[]>();
  const view = mountPicker(async () => pending.promise, [matter]);
  expect(view.getByRole("button", { name: matter.name })).toBeDefined();
  await act(async () => pending.reject(new Error("matter refetch failed")));
  await waitFor(() => expect(view.queryByRole("alert")).not.toBeNull());
  expect(view.getByRole("button", { name: matter.name })).toBeDefined();
  expect(
    view.getByRole("button", { name: messages.common.retry }),
  ).toBeDefined();
  expect(view.queryByText(messages.inspector.matterPicker.empty)).toBeNull();
});

test("a successful zero-matter read shows the empty matter message", async () => {
  const view = mountPicker(async () => []);
  await waitFor(() =>
    expect(
      view.queryByText(messages.inspector.matterPicker.empty),
    ).not.toBeNull(),
  );
  expect(view.queryByRole("alert")).toBeNull();
});

test("a failed refetch of a cached empty matter list still shows retry", async () => {
  const pending = Promise.withResolvers<NeedsMatterMatter[]>();
  const view = mountPicker(async () => pending.promise, []);
  expect(view.getByText(messages.inspector.matterPicker.empty)).toBeDefined();
  await act(async () =>
    pending.reject(new Error("empty matter refetch failed")),
  );
  await waitFor(() => expect(view.queryByRole("alert")).not.toBeNull());
  expect(view.queryByText(messages.inspector.matterPicker.empty)).toBeNull();
  expect(
    view.getByRole("button", { name: messages.common.retry }),
  ).toBeDefined();
});
