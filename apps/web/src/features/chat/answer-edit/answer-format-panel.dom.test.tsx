import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { createTestState } from "../../../../../api/src/tests/helpers/test-state";

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
const messageResource = api.chat
  .threads({ threadId: "thread-1" })
  .messages({ messageId: "message-1" });
type CurrentAnswer = NonNullable<
  Awaited<ReturnType<typeof messageResource.get>>["data"]
>;
const requests: { method: string; body: unknown }[] = [];
let acceptStatus = 200;
const boundary = spyOn(globalThis, "fetch").mockImplementation(
  async (_input, init) => {
    const method = init?.method ?? "GET";
    requests.push({
      method,
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
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
      id: "message-1",
      role: "assistant",
      edited: true,
      createdAt: "2026-10-10T10:00:00Z",
      parts: [{ type: "text", content: "old text" }],
      content: {
        version: 3,
        data: [{ type: "text", content: "old text" }],
        metadata: { sendMode: "rawOverride" },
      },
    } satisfies CurrentAnswer);
  },
);
afterEach(async () => {
  await act(async () => cleanup());
  requests.length = 0;
  acceptStatus = 200;
});
afterAll(async () => {
  boundary.mockRestore();
  await GlobalRegistrator.unregister();
});

const mount = ({
  onCancel,
  onAnswerEdited,
}: {
  onCancel: () => void;
  onAnswerEdited: () => Promise<void>;
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
            entry="bold"
            anchor={{
              messageId: "message-1",
              baseRevision: 2,
              start: 0,
              end: 8,
              selectedSource: "old text",
            }}
            selection={{
              source: "old text",
              start: 0,
              end: 8,
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

test("link addresses reject unsafe schemes and Remove link emits the existing destination toggle", async () => {
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
  expect(actions).toEqual([{ format: "link", url: "https://example.test" }]);
});
