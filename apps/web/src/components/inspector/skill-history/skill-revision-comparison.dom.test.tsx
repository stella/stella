import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import type { MarkdownHybridEditorHandle } from "@/components/markdown/markdown-hybrid-editor";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
// Happy DOM omits the legacy editing API that the EditContext polyfill wraps.
Object.defineProperties(document, {
  execCommand: { value: () => false, configurable: true, writable: true },
  queryCommandEnabled: {
    value: () => false,
    configurable: true,
    writable: true,
  },
  queryCommandSupported: {
    value: () => false,
    configurable: true,
    writable: true,
  },
  queryCommandState: { value: () => false, configurable: true, writable: true },
  queryCommandValue: { value: () => "", configurable: true, writable: true },
});

const { render, cleanup, fireEvent, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider, QueryObserver, useQuery } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { useQueryView } = await import("@/lib/use-query-view");
const { SkillRevisionComparison } = await import("./skill-revision-comparison");
const messages = (await import("@/i18n/langs/en.json")).default;

afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
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
    return { body: "Recovered revision" };
  };
  const Read = () => {
    const view = useQueryView(
      useQuery({
        queryKey: ["skill-revision-comparison", "retry"],
        queryFn: read,
      }),
    );
    return (
      <SkillRevisionComparison view={view}>
        {(baseline) => <span>{baseline}</span>}
      </SkillRevisionComparison>
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
  expect(screen.getByText("Recovered revision")).toBeTruthy();
  cleanup();
  client.clear();
});

test("revision transitions retain the live editor and its local source", async () => {
  const { createRef } = await import("react");
  const { MarkdownHybridEditor } =
    await import("@/components/markdown/markdown-hybrid-editor");
  const client = new QueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ["skill-revision-comparison", "transitions"],
    queryFn: async () => ({ body: "Initial revision" }),
    enabled: false,
  });
  const retry = observer.getCurrentResult().refetch;
  const editor = createRef<MarkdownHybridEditorHandle>();
  const persisted: string[] = [];
  const renderEditor = (
    view: Parameters<typeof SkillRevisionComparison>[0]["view"],
  ) => (
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <SkillRevisionComparison view={view}>
        {(baseline) => (
          <MarkdownHybridEditor
            ref={editor}
            imagePolicy="data-only"
            markdown="Stored source"
            baseline={baseline}
            onMarkdownChange={(text) => {
              persisted.push(text);
            }}
          />
        )}
      </SkillRevisionComparison>
    </IntlProvider>
  );
  const screen = render(
    renderEditor({
      type: "items",
      items: { body: "Initial revision" },
      retry,
    }),
  );
  await waitFor(() => expect(editor.current).not.toBeNull());
  const original = screen.getByRole("region");
  editor.current?.resetMarkdown("Local draft");
  for (const view of [
    { type: "pending" },
    { type: "empty" },
    {
      type: "error",
      error: new Error("Read unavailable"),
      retry,
    },
    {
      type: "items",
      items: { body: "Revision source" },
      retry,
    },
    {
      type: "items",
      items: { body: "Refetched source" },
      retry,
    },
    null,
    { type: "pending" },
  ] satisfies Parameters<typeof SkillRevisionComparison>[0]["view"][]) {
    screen.rerender(renderEditor(view));
    expect(screen.getByRole("region")).toBe(original);
    expect(editor.current?.captureForSave()).toBe("Local draft");
  }
  expect(persisted).not.toContain("Stored source");
  cleanup();
  observer.destroy();
  client.clear();
});
