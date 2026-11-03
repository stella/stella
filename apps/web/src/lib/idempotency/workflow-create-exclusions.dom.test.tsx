import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";

import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, fireEvent, render, renderHook, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { useCalendarCreateTask } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-view");
const { KanbanView } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view");
const { ExistingFileOrganizerDialog } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/existing-file-organizer-dialog");
const { propertiesOptions } =
  await import("@/lib/workspaces/queries/properties");
const { getInternalPropertyId } =
  await import("@/components/workspaces/entity-utils");
const messages = (await import("@/i18n/langs/en.json")).default;
const originalFetch = globalThis.fetch;
const clients: InstanceType<typeof QueryClient>[] = [];
const workspaceId = "00000000-0000-4000-8000-000000000001";
const propertyId = "00000000-0000-4000-8000-000000000002";
const entityId = "00000000-0000-4000-8000-000000000003";
const folderId = "00000000-0000-4000-8000-000000000004";
const oldFolderId = "00000000-0000-4000-8000-000000000005";

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  for (const client of clients.splice(0)) {
    client.clear();
  }
});
afterAll(unregisterDomEnvironment);

const createClient = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return client;
};
const Providers = ({
  children,
  client,
}: {
  children: ReactNode;
  client: InstanceType<typeof QueryClient>;
}) => (
  <IntlProvider locale="en" messages={messages}>
    <AuthenticatedUserProvider
      user={{
        id: "user",
        activeOrganizationId: "org",
        email: "reviewer@example.test",
        name: "Reviewer",
        image: null,
        preferredName: null,
        timezoneId: "Europe/Prague",
        wordEditShortcut: null,
      }}
    >
      <FormattingProvider locale="en" timeZone="UTC">
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </FormattingProvider>
    </AuthenticatedUserProvider>
  </IntlProvider>
);
const serveRequests = (respond: (request: Request) => Response) => {
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return respond(request);
    },
    { preconnect: originalFetch.preconnect },
  );
  return requests;
};

test("calendar creates a task then its custom date field without a replay header", async () => {
  const requests = serveRequests(() => Response.json({ entityId }));
  const client = createClient();
  const { result } = renderHook(
    () => useCalendarCreateTask({ workspaceId, datePropertyId: propertyId }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <Providers client={client}>{children}</Providers>
      ),
    },
  );
  await act(async () => {
    await result.current("2026-10-27", "task");
  });
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(
    requests.map((request) => [request.method, new URL(request.url).pathname]),
  ).toEqual([
    ["PUT", `/v1/tasks/${workspaceId}`],
    ["POST", `/v1/fields/${workspaceId}`],
  ]);
  expect(requests.at(0)?.headers.get("Idempotency-Key")).toBeNull();
  expect(await requests.at(1)?.json()).toMatchObject({
    entityId,
    propertyId,
    content: { type: "date", value: "2026-10-27" },
  });
});

test("kanban creates a task then its subgroup field without a replay header", async () => {
  const property = {
    id: toSafeId<"property">(propertyId),
    workspaceId: toSafeId<"workspace">(workspaceId),
    name: "Phase",
    createdAt: "2026-01-01T00:00:00Z",
    status: "fresh",
    kinds: null,
    content: {
      version: 1,
      type: "single-select",
      options: [{ value: "Review", color: "gray" }],
      fallback: null,
    },
    tool: { version: 1, type: "manual-input" },
  } satisfies WorkspaceProperty;
  const view = {
    id: "kanban-view",
    version: 1,
    name: "Tasks",
    position: 0,
    createdAt: "2026-01-01T00:00:00Z",
    layout: {
      version: 1,
      type: "kanban",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      calculations: [],
      groupByPropertyId: getInternalPropertyId("status"),
      subgroupByPropertyId: propertyId,
    },
  } satisfies WorkspaceView;
  const requests = serveRequests((request) =>
    Response.json(
      request.method === "PUT" ? { entityId } : { items: [], nextCursor: null },
    ),
  );
  const client = createClient();
  client.setQueryData(propertiesOptions(workspaceId).queryKey, [property]);
  const rendered = render(
    <Providers client={client}>
      <KanbanView workspaceId={workspaceId} view={view} />
    </Providers>,
  );
  fireEvent.click(await rendered.findByText("Review"));
  const button = await waitFor(() =>
    rendered.getAllByRole("button", { name: messages.tasks.newTask }).at(0),
  );
  expect(button).toBeDefined();
  assert.ok(button);
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      requests.some(
        (request) =>
          new URL(request.url).pathname === `/v1/fields/${workspaceId}`,
      ),
    ).toBe(true),
  );
  const created = requests.find((request) => request.method === "PUT");
  expect(created?.headers.get("Idempotency-Key")).toBeNull();
  const field = requests.find(
    (request) => new URL(request.url).pathname === `/v1/fields/${workspaceId}`,
  );
  expect(await field?.json()).toMatchObject({
    entityId,
    propertyId,
    content: { type: "single-select", value: "Review" },
  });
});

test("the organizer creates folders before move rename and delete without a replay header", async () => {
  const requests = serveRequests((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("organize-suggestions")) {
      return Response.json({
        suggestions: [
          {
            entityId,
            folderPath: "Reviewed",
            suggestedName: "reviewed.docx",
            detectedDate: null,
            documentType: "agreement",
          },
        ],
        deleteFolders: [
          { entityId: oldFolderId, folderPath: "Old", reason: "Empty" },
        ],
      });
    }
    return Response.json({ entityId: folderId });
  });
  const client = createClient();
  const rendered = render(
    <Providers client={client}>
      <ExistingFileOrganizerDialog
        workspaceId={workspaceId}
        files={[
          {
            entityId,
            originalName: "original.docx",
            parentId: null,
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ]}
        existingFolders={[
          { entityId: oldFolderId, name: "Old", path: "Old", parentId: null },
        ]}
        open
        onOpenChange={() => undefined}
      />
    </Providers>,
  );
  fireEvent.click(
    await rendered.findByRole("button", {
      name: messages.workspaces.importOrganizer.generateAi,
    }),
  );
  await waitFor(() =>
    expect(
      rendered
        .getByRole("button", {
          name: messages.workspaces.importOrganizer.apply,
        })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    rendered.getByRole("button", {
      name: messages.workspaces.importOrganizer.apply,
    }),
  );
  await waitFor(() =>
    expect(requests.some((request) => request.method === "DELETE")).toBe(true),
  );
  const writes = requests.filter(
    (request) =>
      !new URL(request.url).pathname.endsWith("organize-suggestions"),
  );
  expect(
    writes.map((request) => [request.method, new URL(request.url).pathname]),
  ).toEqual([
    ["PUT", `/v1/entities/${workspaceId}`],
    ["PATCH", `/v1/entities/${workspaceId}/move`],
    ["PATCH", `/v1/entities/${workspaceId}/rename`],
    ["DELETE", `/v1/entities/${workspaceId}`],
  ]);
  expect(writes.at(0)?.headers.get("Idempotency-Key")).toBeNull();
  expect(await writes.at(1)?.json()).toMatchObject({
    entityId,
    parentId: folderId,
  });
  expect(await writes.at(2)?.json()).toMatchObject({
    entityId,
    name: "reviewed.docx",
  });
  expect(await writes.at(3)?.json()).toEqual({ entityIds: [oldFolderId] });
});
