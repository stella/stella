import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
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
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { createAppQueryClient } = await import("@/lib/react-query");
const { AnswerRevisionHistoryContent } =
  await import("./answer-revision-history");
const { api } = await import("@/lib/api");
const { toSafeId } = await import("@/lib/safe-id");
const revisionResource = api.chat
  .threads({ threadId: "thread-1" })
  .messages({ messageId: "message-1" }).revisions;
type RevisionPage = NonNullable<
  Awaited<ReturnType<typeof revisionResource.get>>["data"]
>;
const defaultPage = {
  items: [
    {
      id: toSafeId<"chatMessageRevision">("revision-2"),
      revision: 2,
      messageId: toSafeId<"chatMessage">("message-1"),
      threadId: toSafeId<"chatThread">("thread-1"),
      workspaceId: null,
      createdBy: null,
      content: {
        version: 3,
        data: [{ type: "text", content: "old text" }],
      },
      createdAt: "2026-10-10T10:00:00Z",
      actorName: null,
      beforeText: "old text",
      afterText: "**old text**",
      edit: { type: "format", format: "bold", start: 0, end: 8 },
    },
  ],
  nextCursor: null,
  limit: 20,
} satisfies RevisionPage;
let readPages: Map<string, RevisionPage> | undefined;
const readPage = (input: RequestInfo | URL) => {
  if (readPages === undefined) {
    return defaultPage;
  }
  const url = new URL(new Request(input).url);
  const cursor = url.searchParams.get("cursor") ?? "";
  const page = readPages.get(cursor);
  if (page === undefined) {
    panic(`Unexpected revision cursor: ${cursor}`);
  }
  return page;
};
let readStatus = 200;
let writeStatus = 200;
const writes: unknown[] = [];
const boundary = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "POST") {
        writes.push(await request.json());
        return Response.json(
          writeStatus === 409
            ? { message: "Changed" }
            : { revision: 4, edited: true },
          { status: writeStatus },
        );
      }
      return Response.json(
        readStatus === 200 ? readPage(input) : { message: "Failed" },
        { status: readStatus },
      );
    },
    { preconnect: () => undefined },
  ),
);
afterEach(async () => {
  await act(async () => cleanup());
  writes.length = 0;
  readStatus = 200;
  writeStatus = 200;
  readPages = undefined;
});
afterAll(async () => {
  boundary.mockRestore();
  await GlobalRegistrator.unregister();
});
const mount = ({
  refresh,
  disabled = false,
  revision = 3,
  client = createAppQueryClient(),
}: {
  refresh: (messageId: string) => Promise<void>;
  disabled?: boolean;
  revision?: number;
  client?: ReturnType<typeof createAppQueryClient>;
}) =>
  render(
    <AuthenticatedUserProvider user={USER}>
      <QueryClientProvider client={client}>
        <IntlProvider
          locale="en"
          messages={messages}
          timeZone="UTC"
          onError={(error) => {
            throw error;
          }}
        >
          <FormattingProvider locale="en" timeZone="UTC">
            <AnswerRevisionHistoryContent
              threadId="thread-1"
              messageId="message-1"
              revision={revision}
              disabled={disabled}
              onAnswerEdited={refresh}
            />
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>
    </AuthenticatedUserProvider>,
  );

test("history shows actor and kind, previews the applied diff and restores by appending a revision", async () => {
  const refreshed: string[] = [];
  const view = mount({
    refresh: async (id) => {
      refreshed.push(id);
    },
  });
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Change 3" })).toBeTruthy(),
  );
  expect(view.getByText(messages.chat.answerEdit.authorUnknown)).toBeTruthy();
  expect(
    view.getByText(messages.chat.answerEdit.formatKind, { exact: false }),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Change 3" }));
  expect(view.container.querySelector("del")?.textContent).toBe("old text");
  expect(view.container.querySelector("ins")?.textContent).toBe("**old text**");
  fireEvent.click(
    view.getByRole("button", { name: messages.clauses.restoreVersion }),
  );
  await waitFor(() => expect(refreshed).toEqual(["message-1"]));
  expect(writes).toEqual([{ baseRevision: 3 }]);
});

test("history read failures expose retry and recover", async () => {
  readStatus = 500;
  const view = mount({ refresh: async () => undefined });
  await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
  readStatus = 200;
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Change 3" })).toBeTruthy(),
  );
});

test("revert conflicts reload the canonical answer and expose stale selection", async () => {
  writeStatus = 409;
  let refreshed = 0;
  const view = mount({
    refresh: async () => {
      refreshed++;
    },
  });
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Change 3" })).toBeTruthy(),
  );
  fireEvent.click(view.getByRole("button", { name: "Change 3" }));
  fireEvent.click(
    view.getByRole("button", { name: messages.clauses.restoreVersion }),
  );
  await waitFor(() => expect(refreshed).toBe(1));
  expect(view.getByRole("alert").textContent).toContain(
    messages.chat.answerEdit.stale,
  );
});

test("streaming preserves history browsing and disables restore", async () => {
  const view = mount({ refresh: async () => undefined, disabled: true });
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Change 3" })).toBeTruthy(),
  );
  fireEvent.click(view.getByRole("button", { name: "Change 3" }));
  expect(
    view
      .getByRole("button", { name: messages.clauses.restoreVersion })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("loading four history pages preserves the newest revisions when reopened", async () => {
  readPages = new Map(
    [4, 3, 2, 1].map((revision) => [
      revision === 4 ? "" : `cursor-${revision}`,
      {
        items: defaultPage.items.map((item) => ({
          ...item,
          id: toSafeId<"chatMessageRevision">(`revision-${revision}`),
          revision,
        })),
        nextCursor: revision === 1 ? null : `cursor-${revision - 1}`,
        limit: 20,
      } satisfies RevisionPage,
    ]),
  );
  const client = createAppQueryClient();
  const open = () =>
    mount({ refresh: async () => undefined, client, revision: 5 });
  const view = open();
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Change 5" })).toBeTruthy(),
  );
  for (const change of [4, 3, 2]) {
    fireEvent.click(
      view.getByRole("button", { name: messages.common.loadMore }),
    );
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: `Change ${change}` }),
      ).toBeTruthy(),
    );
  }
  expect(
    view.queryByRole("button", { name: messages.common.loadMore }),
  ).toBeNull();
  expect(view.getByRole("button", { name: "Change 5" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Change 5" }));
  expect(view.baseElement.querySelector("del")?.textContent).toBe("old text");
  await act(async () => view.unmount());
  expect(view.queryByRole("button", { name: "Change 5" })).toBeNull();
  const reopened = open();
  await waitFor(() => {
    for (const change of [5, 4, 3, 2]) {
      expect(
        reopened.getByRole("button", { name: `Change ${change}` }),
      ).toBeTruthy();
    }
  });
  fireEvent.click(reopened.getByRole("button", { name: "Change 5" }));
  expect(reopened.baseElement.querySelector("ins")?.textContent).toBe(
    "**old text**",
  );
});
