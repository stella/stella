import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register();
const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { BreadcrumbQueryContent } = await import("./query-content");
const { queryView } = await import("@/lib/query-view.logic");
const messages = (await import("@/i18n/langs/en.json")).default;
afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const savedNameFixture = "Rename saved name";

const mount = (view: Parameters<typeof BreadcrumbQueryContent>[0]["view"]) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <ol>
        <BreadcrumbQueryContent view={view}>
          <li>{savedNameFixture}</li>
        </BreadcrumbQueryContent>
      </ol>
    </IntlProvider>,
  );

test("breadcrumb name reads keep pending and failure separate from editable fallback names", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let attempts = 0;
  const read = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("Name read failed");
    }
    return "Confirmed name";
  };
  const observer = new QueryObserver(client, {
    queryKey: ["breadcrumb"],
    enabled: false,
    queryFn: read,
  });
  const pending = mount(queryView(observer.getCurrentResult()));
  expect(pending.getByRole("status")).toBeDefined();
  expect(pending.queryByText(savedNameFixture)).toBeNull();
  pending.unmount();
  const failed = mount(queryView(await observer.refetch()));
  expect(failed.getByRole("alert")).toBeDefined();
  expect(failed.queryByText(savedNameFixture)).toBeNull();
  fireEvent.click(failed.getByRole("button", { name: messages.common.retry }));
  await waitFor(() =>
    expect(observer.getCurrentResult().status).toBe("success"),
  );
  failed.unmount();
  const ready = mount(queryView(observer.getCurrentResult()));
  expect(ready.getByText(savedNameFixture)).toBeDefined();
  expect(ready.queryByRole("alert")).toBeNull();
  observer.destroy();
  client.clear();
});

test("a failed breadcrumb refresh keeps the saved name and exposes retry", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["breadcrumb"], "Saved name");
  const observer = new QueryObserver(client, {
    queryKey: ["breadcrumb"],
    enabled: false,
    queryFn: async () => {
      throw new Error("Refresh failed");
    },
  });
  const ui = mount(queryView(await observer.refetch()));
  expect(ui.getByText(savedNameFixture)).toBeDefined();
  expect(ui.getByRole("alert")).toBeDefined();
  expect(ui.getByRole("button", { name: messages.common.retry })).toBeDefined();
  observer.destroy();
  client.clear();
});
