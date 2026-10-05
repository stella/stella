import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register();

const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { DocxSuggestionsQueryStatus } =
  await import("./docx-suggestions-query-status");
const { queryView } = await import("@/lib/query-view.logic");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const renderStatus = (
  view: Parameters<typeof DocxSuggestionsQueryStatus>[0]["view"],
) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <DocxSuggestionsQueryStatus view={view} />
    </IntlProvider>,
  );

test("persisted suggestion reads show pending and failed reads offer a working retry", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let attempts = 0;
  const read = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("read failed");
    }
    return { items: [] };
  };
  const observer = new QueryObserver(client, {
    queryKey: ["suggestions"],
    queryFn: read,
    enabled: false,
  });
  const pending = renderStatus(queryView(observer.getCurrentResult()));
  expect(pending.getByRole("status").textContent).toBe(messages.common.loading);
  pending.unmount();

  const failed = await observer.refetch();
  expect(failed.status).toBe("error");
  const status = renderStatus(queryView(failed));
  expect(status.getByRole("alert").textContent).toContain(
    messages.errors.actionFailed,
  );
  fireEvent.click(status.getByRole("button", { name: messages.common.retry }));
  await waitFor(() => expect(attempts).toBe(2));
  await waitFor(() =>
    expect(observer.getCurrentResult().status).toBe("success"),
  );
  observer.destroy();
  client.clear();
});

for (const items of [[], [{ id: "cached-suggestion" }]]) {
  test(`failed suggestion refresh keeps ${items.length} cached suggestions and shows retry`, async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const cached = { items };
    client.setQueryData(["suggestions"], cached);
    let attempts = 0;
    const read = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("refresh failed");
      }
      return cached;
    };
    const observer = new QueryObserver(client, {
      queryKey: ["suggestions"],
      queryFn: read,
      enabled: false,
    });
    const refreshed = await observer.refetch();
    const view = queryView(refreshed, {
      isEmpty: ({ items: suggestions }) => suggestions.length === 0,
    });
    expect(view.type).toBe("items");
    switch (view.type) {
      case "items": {
        expect(view.items).toBe(cached);
        const status = renderStatus(view);
        expect(status.getByRole("alert").textContent).toContain(
          messages.errors.actionFailed,
        );
        fireEvent.click(
          status.getByRole("button", { name: messages.common.retry }),
        );
        await waitFor(() =>
          expect(observer.getCurrentResult().status).toBe("success"),
        );
        expect(attempts).toBe(2);
        expect(observer.getCurrentResult().data).toBe(cached);
        break;
      }
      case "pending":
      case "error":
      case "empty":
        throw new Error("cached suggestions were discarded");
      default:
        view satisfies never;
        throw new Error("Unhandled suggestions query state");
    }
    observer.destroy();
    client.clear();
  });
}

test("successful empty suggestion history does not show an error or pending notice", () => {
  const status = renderStatus({ type: "empty" });
  expect(status.queryByRole("alert")).toBeNull();
  expect(status.queryByRole("status")).toBeNull();
});
