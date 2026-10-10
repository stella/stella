import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import { createTestState } from "../../../../../api/src/tests/helpers/test-state";
import type { AnswerFormatPanelProps } from "./answer-format-panel";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });
const state = createTestState({ file: import.meta.path, config: {} });
state.setEnv(
  "VITE_API_URL",
  process.env["VITE_API_URL"] ?? "https://api.example.test",
);
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const USER = {
  id: "viewer",
  activeOrganizationId: "organization",
  email: "viewer@example.test",
  image: null,
  name: "Viewer",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const { QueryClientProvider } = await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { AnswerFormatPanel } = await import("./answer-format-panel");
const { createAppQueryClient } = await import("@/lib/react-query");
const { api } = await import("@/lib/api");
const { toSafeId } = await import("@/lib/safe-id");
const messageResource = api.chat
  .threads({ threadId: "thread-1" })
  .messages({ messageId: "message-1" });
type CurrentAnswer = NonNullable<
  Awaited<ReturnType<typeof messageResource.get>>["data"]
>;
const requests: { method: string; body: unknown }[] = [];
let acceptStatus = 200;
let answerSource = "old text";
const boundary = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const method = request.method;
      requests.push({
        method,
        body: request.body === null ? undefined : await request.json(),
      });
      if (method === "POST") {
        return Response.json(
          acceptStatus === 409
            ? { message: "Changed" }
            : { revision: 3, edited: true },
          { status: acceptStatus },
        );
      }
      return Response.json({
        revision: 2,
        id: toSafeId<"chatMessage">("message-1"),
        role: "assistant",
        edited: true,
        createdAt: "2026-10-10T10:00:00Z",
        parts: [{ type: "text", content: answerSource }],
        content: {
          version: 3,
          data: [{ type: "text", content: answerSource }],
          metadata: { sendMode: "rawOverride" },
        },
      } satisfies CurrentAnswer);
    },
    { preconnect: () => undefined },
  ),
);
afterEach(async () => {
  await act(async () => cleanup());
  requests.length = 0;
  acceptStatus = 200;
  answerSource = "old text";
});
afterAll(async () => {
  boundary.mockRestore();
  await GlobalRegistrator.unregister();
});

const mount = ({
  onCancel,
  onAnswerEdited,
  entry = "bold",
  start = 0,
  end = answerSource.length,
}: {
  onCancel: () => void;
  onAnswerEdited: () => Promise<void>;
  entry?: AnswerFormatPanelProps["entry"];
  start?: number;
  end?: number;
}) =>
  render(
    <AuthenticatedUserProvider user={USER}>
      <QueryClientProvider client={createAppQueryClient()}>
        <IntlProvider
          locale="en"
          messages={messages}
          timeZone="UTC"
          onError={(error) => {
            throw error;
          }}
        >
          <AnswerFormatPanel
            entry={entry}
            anchor={{
              messageId: "message-1",
              baseRevision: 2,
              start,
              end,
              selectedSource: answerSource.slice(start, end),
            }}
            selection={{
              source: answerSource,
              start,
              end,
              partIndex: 0,
              partOffset: 0,
            }}
            threadId="thread-1"
            disabled={false}
            onCancel={onCancel}
            onAnswerEdited={onAnswerEdited}
          />
        </IntlProvider>
      </QueryClientProvider>
    </AuthenticatedUserProvider>,
  );

test("formatting previews canonical Markdown and accepts through the revision boundary without a model", async () => {
  let refreshed = 0;
  const view = mount({
    onCancel: () => undefined,
    onAnswerEdited: async () => {
      refreshed++;
    },
  });
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Accept" })).toBeTruthy(),
  );
  expect(view.container.querySelector("ins")?.textContent).toBe("**old text**");
  fireEvent.click(view.getByRole("button", { name: "Accept" }));
  await waitFor(() => expect(refreshed).toBe(1));
  expect(
    requests.find((request) => request.method === "POST")?.body,
  ).toMatchObject({
    baseRevision: 2,
    content: {
      data: [{ type: "text", content: "**old text**" }],
      metadata: { sendMode: "rawOverride" },
    },
    edit: { type: "format", format: "bold", start: 0, end: 8 },
  });
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(
    1,
  );
});

test("discarding a formatting proposal performs no revision write", async () => {
  let cancelled = 0;
  const view = mount({
    onCancel: () => {
      cancelled++;
    },
    onAnswerEdited: async () => undefined,
  });
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Undo" })).toBeTruthy(),
  );
  fireEvent.click(view.getByRole("button", { name: "Undo" }));
  expect(cancelled).toBe(1);
  expect(requests.some((request) => request.method === "POST")).toBe(false);
});

test("format acceptance conflict reloads the answer before requesting a new selection", async () => {
  acceptStatus = 409;
  let refreshed = 0;
  const view = mount({
    onCancel: () => undefined,
    onAnswerEdited: async () => {
      refreshed++;
    },
  });
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Accept" })).toBeTruthy(),
  );
  fireEvent.click(view.getByRole("button", { name: "Accept" }));
  await waitFor(() => expect(refreshed).toBe(1));
  expect(view.getByRole("alert").textContent).toContain(
    messages.chat.answerEdit.stale,
  );
});

test("link addresses reject unsafe schemes and Remove link emits explicit removal", async () => {
  const { AnswerLinkForm } = await import("./answer-link-form");
  const actions: unknown[] = [];
  const view = render(
    <IntlProvider
      locale="en"
      messages={messages}
      timeZone="UTC"
      onError={(error) => {
        throw error;
      }}
    >
      <AnswerLinkForm
        existingUrl="https://example.test"
        disabled={false}
        onCancel={() => undefined}
        onAction={(action) => {
          actions.push(action);
        }}
      />
    </IntlProvider>,
  );
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "mailto:viewer@example.test" },
  });
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
  expect(actions).toHaveLength(0);
  expect(view.getByRole("textbox").getAttribute("aria-describedby")).toBe(
    view.getByRole("alert").id,
  );
  fireEvent.click(
    view.getByRole("button", { name: messages.folio.removeLink }),
  );
  expect(actions).toEqual([{ format: "link", intent: "remove" }]);
});

test("confirming an unchanged link address emits no action", async () => {
  const { AnswerLinkForm } = await import("./answer-link-form");
  const actions: unknown[] = [];
  const view = render(
    <IntlProvider locale="en" messages={messages}>
      <AnswerLinkForm
        existingUrl="https://example.test"
        disabled={false}
        onCancel={() => undefined}
        onAction={(action) => actions.push(action)}
      />
    </IntlProvider>,
  );
  await act(async () =>
    fireEvent.click(
      view.getByRole("button", { name: messages.common.confirm }),
    ),
  );
  expect(actions).toEqual([]);
});

test("confirming an unchanged link keeps its source without proposing or writing a revision", async () => {
  answerSource = "[old text](https://example.test)";
  const original = answerSource;
  const view = mount({
    entry: "link",
    start: 1,
    end: 9,
    onCancel: () => undefined,
    onAnswerEdited: async () => undefined,
  });
  expect(view.getByRole("textbox").getAttribute("value")).toBe(
    "https://example.test/",
  );
  await act(async () =>
    fireEvent.click(
      view.getByRole("button", { name: messages.common.confirm }),
    ),
  );
  expect(view.queryByRole("button", { name: "Accept" })).toBeNull();
  expect(view.container.querySelector("ins")).toBeNull();
  expect(requests).toEqual([]);
  expect(view.getByRole("textbox").getAttribute("value")).toBe(
    "https://example.test/",
  );
  expect(answerSource).toBe(original);
});

test("confirming a changed link explicitly sets its destination in the preview and accepted revision", async () => {
  answerSource = "[old text](https://example.test)";
  const view = mount({
    entry: "link",
    start: 1,
    end: 9,
    onCancel: () => undefined,
    onAnswerEdited: async () => undefined,
  });
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "https://updated.test" },
  });
  fireEvent.click(view.getByRole("button", { name: messages.common.confirm }));
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Accept" })).toBeTruthy(),
  );
  expect(view.container.querySelector("ins")?.textContent).toBe(
    "[old text](<https://updated.test/>)",
  );
  fireEvent.click(view.getByRole("button", { name: "Accept" }));
  await waitFor(() =>
    expect(requests.some((request) => request.method === "POST")).toBe(true),
  );
  expect(
    requests.find((request) => request.method === "POST")?.body,
  ).toMatchObject({
    content: {
      data: [{ type: "text", content: "[old text](<https://updated.test/>)" }],
    },
    edit: {
      type: "format",
      format: "link",
      intent: "set",
      url: "https://updated.test/",
    },
  });
});

test("Remove link explicitly unlinks a URL-shaped label while preserving its visible text", async () => {
  answerSource = "<https://example.test>";
  const view = mount({
    entry: "link",
    start: 1,
    end: answerSource.length - 1,
    onCancel: () => undefined,
    onAnswerEdited: async () => undefined,
  });
  fireEvent.click(
    view.getByRole("button", { name: messages.folio.removeLink }),
  );
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Accept" })).toBeTruthy(),
  );
  const replacement = view.container.querySelector("ins")?.textContent;
  expect(typeof replacement).toBe("string");
  if (typeof replacement !== "string") {
    return;
  }
  const tree = fromMarkdown(replacement, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  expect(tree.children).toMatchObject([
    {
      type: "paragraph",
      children: [{ type: "text", value: "https://example.test" }],
    },
  ]);
  fireEvent.click(view.getByRole("button", { name: "Accept" }));
  await waitFor(() =>
    expect(requests.some((request) => request.method === "POST")).toBe(true),
  );
  expect(
    requests.find((request) => request.method === "POST")?.body,
  ).toMatchObject({
    content: { data: [{ type: "text", content: replacement }] },
    edit: { type: "format", format: "link", intent: "remove" },
  });
});
