import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

GlobalRegistrator.register();

const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { QueryViewFeedback } = await import("./query-view-feedback");
const { queryView } = await import("@/lib/query-view.logic");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const renderFeedback = (
  view: Parameters<typeof QueryViewFeedback>[0]["view"],
) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <QueryViewFeedback view={view} />
    </IntlProvider>,
  );

test("an initial failure offers retry instead of appearing empty", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const read = mock(async () => [])
    .mockRejectedValueOnce(new Error("read failed"))
    .mockResolvedValue([]);
  const observer = new QueryObserver(client, {
    queryKey: ["initial-feedback"],
    queryFn: read,
    enabled: false,
  });
  const pending = renderFeedback(queryView(observer.getCurrentResult()));
  expect(pending.getByRole("status").textContent).toBe(messages.common.loading);
  pending.unmount();

  const failed = renderFeedback(queryView(await observer.refetch()));
  expect(failed.getByRole("alert").textContent).toContain(
    messages.common.somethingWentWrong,
  );
  fireEvent.click(failed.getByRole("button", { name: messages.common.retry }));
  await waitFor(() =>
    expect(observer.getCurrentResult().status).toBe("success"),
  );
  expect(read).toHaveBeenCalledTimes(2);
  failed.unmount();
  const empty = renderFeedback(queryView(observer.getCurrentResult()));
  expect(empty.queryByRole("alert")).toBeNull();
  expect(empty.queryByRole("status")).toBeNull();
  observer.destroy();
  client.clear();
});

for (const cached of [[], ["cached-item"]]) {
  test(`a failed refresh retains ${cached.length} cached items and offers retry`, async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["cached-feedback"], cached);
    const read = mock(async () => cached)
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValue(cached);
    const observer = new QueryObserver(client, {
      queryKey: ["cached-feedback"],
      queryFn: read,
      enabled: false,
    });
    const view = queryView(await observer.refetch());
    expect(view.type).toBe("items");
    if (view.type !== "items") {
      throw new Error("Cached content was discarded");
    }
    expect(view.items).toBe(cached);
    const feedback = renderFeedback(view);
    expect(feedback.getByRole("alert")).toBeDefined();
    fireEvent.click(
      feedback.getByRole("button", { name: messages.common.retry }),
    );
    await waitFor(() =>
      expect(observer.getCurrentResult().status).toBe("success"),
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult().data).toBe(cached);
    observer.destroy();
    client.clear();
  });
}
