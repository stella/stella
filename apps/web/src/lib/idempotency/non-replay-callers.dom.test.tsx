import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import type { SampleCaseLoad } from "@/features/avt/types";
import { toSafeId } from "@/lib/safe-id";
import type { AvtWorkspaceView } from "@/lib/workspaces/view-layout";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { MessageExportMenu } =
  await import("@/components/chat/message-export-menu");
const { LoadSampleCaseButton } =
  await import("@/features/avt/load-sample-case-button");
const { roleOptions } = await import("@/lib/auth-queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { viewsOptions } = await import("@/lib/workspaces/queries/views");
const messages = (await import("@/i18n/langs/en.json")).default;
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

const wrapper = ({ children }: { children: ReactNode }) => (
  <IntlProvider locale="en" messages={messages}>
    {children}
  </IntlProvider>
);

test("the real message export callback downloads successfully without a replay key", async () => {
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return new URL(request.url).pathname === "/export.docx"
        ? new Response("exported document")
        : Response.json({
            downloadUrl: "https://download.example.test/export.docx",
            fileName: "answer.docx",
          });
    },
    { preconnect: originalFetch.preconnect },
  );
  const objectUrl = spyOn(URL, "createObjectURL").mockReturnValue(
    "blob:export",
  );
  const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(
    () => undefined,
  );
  const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    () => undefined,
  );
  const closed: boolean[] = [];
  const message = {
    id: "00000000-0000-4000-8000-000000000001",
    role: "assistant",
    parts: [{ type: "text", content: "Reviewed agreement." }],
  } satisfies PersistedChatMessage;
  const anchor = document.createElement("button");
  document.body.append(anchor);
  try {
    const view = render(
      <MessageExportMenu
        anchor={anchor}
        open
        onOpenChange={(open) => {
          closed.push(open);
        }}
        threadRef={{
          scope: "global",
          threadId: toSafeId<"chatThread">(
            "00000000-0000-4000-8000-000000000002",
          ),
        }}
        message={message}
      />,
      { wrapper },
    );
    fireEvent.click(
      await waitFor(() =>
        view.getByRole("button", { name: messages.common.export.title }),
      ),
    );
    await waitFor(() => expect(closed).toContain(false));
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/chat/threads/00000000-0000-4000-8000-000000000002/export",
      "/export.docx",
    ]);
    expect(requests.at(0)?.headers.get("Idempotency-Key")).toBeNull();
    expect(await requests.at(0)?.json()).toMatchObject({
      messageId: message.id,
      format: "docx",
    });
    expect(click).toHaveBeenCalledTimes(1);
  } finally {
    objectUrl.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
    anchor.remove();
  }
});

test("the real sample-case callback creates its sample and opens the list without replay headers", async () => {
  const requests: Request[] = [];
  const workspaceId = "00000000-0000-4000-8000-000000000011";
  const sample = {
    listId: toSafeId<"legalList">("00000000-0000-4000-8000-000000000012"),
    documentEntityId: toSafeId<"entity">(
      "00000000-0000-4000-8000-000000000013",
    ),
    fileFieldId: toSafeId<"field">("00000000-0000-4000-8000-000000000014"),
  } satisfies SampleCaseLoad;
  const view = {
    version: 1,
    id: "00000000-0000-4000-8000-000000000015",
    name: "Verification",
    position: 0,
    createdAt: "2026-10-01T12:00:00Z",
    layout: {
      version: 1,
      type: "avt",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      calculations: [],
      listId: null,
    },
  } satisfies AvtWorkspaceView;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(
        new URL(request.url).pathname.endsWith("sample-case")
          ? sample
          : { ...view, layout: { ...view.layout, listId: sample.listId } },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient({
    defaultOptions: {
      queries: { enabled: false, retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(viewsOptions(workspaceId).queryKey, [view]);
  client.setQueryData(roleOptions.queryKey, "owner");
  const rendered = render(
    <IntlProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "org-test",
            email: "reviewer@example.test",
            id: "user-test",
            image: null,
            name: "Reviewer",
            preferredName: null,
            timezoneId: "Europe/Prague",
            wordEditShortcut: null,
          }}
        >
          <LoadSampleCaseButton view={view} workspaceId={workspaceId} />
        </AuthenticatedUserProvider>
      </QueryClientProvider>
    </IntlProvider>,
  );
  const loadButton = rendered.getByRole("button", {
    name: messages.avt.view.loadSample,
  });
  fireEvent.click(loadButton);
  await waitFor(() => expect(requests).toHaveLength(2));
  await waitFor(() => expect(loadButton.hasAttribute("disabled")).toBe(false));
  expect(requests).toHaveLength(2);
  expect(new URL(requests.at(0)?.url ?? "").pathname).toBe(
    `/v1/lists/${workspaceId}/sample-case`,
  );
  for (const request of requests) {
    expect(request.headers.get("Idempotency-Key")).toBeNull();
  }
  expect(await requests.at(1)?.json()).toMatchObject({
    layout: { listId: sample.listId },
  });
});
