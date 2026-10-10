import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test, spyOn } from "bun:test";

import englishMessages from "@/i18n/langs/en.json";
import type { WorkspaceEntity } from "@/lib/types";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const originalFetch = globalThis.fetch;
const requests: {
  entityId: string;
  name: string;
  answer: ReturnType<typeof Promise.withResolvers<Response>>;
}[] = [];
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/rename")) {
      const requestBody = init?.body;
      if (typeof requestBody !== "string") {
        throw new TypeError("Expected a JSON string body for entity rename");
      }
      const body = JSON.parse(requestBody);
      const answer = Promise.withResolvers<Response>();
      requests.push({ ...body, answer });
      return await answer.promise;
    }
    throw new Error(`Unexpected transport: ${url}`);
  },
  { preconnect: originalFetch.preconnect },
);
const React = await import("react");
const { act, cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
} = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { useRenameEntity } = await import("./entities");
const { KanbanCard } =
  await import("@/components/workspaces/kanban/kanban-card");
const { FilesystemRow } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view");
const { PdfBreadcrumb } =
  await import("@/components/breadcrumbs/pdf-breadcrumb");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { toSafeId } = await import("@/lib/safe-id");
const { rootKeys } = await import("@/lib/auth-queries");
const { propertiesKeys } = await import("@/lib/workspaces/queries/properties");
const { fileMetadataOptions } = await import("@/lib/files/file-metadata-query");

const entity = (id: string) =>
  ({
    entityId: toSafeId<"entity">(id),
    kind: "document",
    name: `${id}.md`,
    parentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
    createdByUserId: null,
    createdByImage: null,
    createdByDeletedAt: null,
    updatedAt: null,
    version: 1,
    currentVersionReference: null,
    status: null,
    priority: null,
    listItemType: "event",
    dueDate: null,
    agendaKind: "event",
    startAt: null,
    endAt: null,
    occurredAt: null,
    remindAt: null,
    allDay: false,
    timeZone: null,
    location: null,
    onlineMeetingUrl: null,
    availability: null,
    sensitivity: null,
    organizer: null,
    attendees: null,
    recurrence: null,
    agendaSource: "manual",
    externalSource: null,
    externalId: null,
    externalChangeKey: null,
    externalICalUid: null,
    readOnly: false,
    sortOrder: null,
    activeEditBy: null,
    fields: {},
    cellMetadata: {},
    assignees: [],
  }) satisfies WorkspaceEntity;

const mount = async (Component: () => ReactNode) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(rootKeys.role, "owner");
  client.setQueryData(propertiesKeys.all("matter"), []);
  client.setQueryData(
    fileMetadataOptions({ workspaceId: "matter", fieldId: "field-A" }).queryKey,
    {
      fileId: "file-A",
      fileName: "A.md",
      mimeType: "text/markdown",
      originalMimeType: "text/markdown",
    },
  );
  const root = createRootRoute({
    component: () => (
      <ChatEditorProvider>
        <Outlet />
      </ChatEditorProvider>
    ),
  });
  const protectedRoute = createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user: { activeOrganizationId: "org" } }),
    component: Outlet,
  });
  const workspace = createRoute({
    getParentRoute: () => protectedRoute,
    path: "workspaces/$workspaceId",
    component: Outlet,
  });
  const viewRoute = createRoute({
    getParentRoute: () => workspace,
    path: "$viewId",
    component: Outlet,
  });
  const document = createRoute({
    getParentRoute: () => viewRoute,
    path: "document",
    validateSearch: (search: Record<string, unknown>) => ({
      entity: typeof search["entity"] === "string" ? search["entity"] : "A",
      field: typeof search["field"] === "string" ? search["field"] : "field-A",
    }),
    component: Component,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      protectedRoute.addChildren([
        workspace.addChildren([viewRoute.addChildren([document])]),
      ]),
    ]),
    history: createMemoryHistory({
      initialEntries: [
        "/workspaces/matter/view/document?entity=A&field=field-A",
      ],
    }),
  });
  await router.load();
  const rendered = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: "org",
              id: "user",
              email: "rename@example.test",
              image: null,
              name: "Rename tester",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <RouterProvider router={router} />
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, client };
};
const refuse = (index: number) =>
  requests
    .at(index)
    ?.answer.resolve(
      Response.json({ message: "Rename refused" }, { status: 409 }),
    );
const confirm = (index: number) => {
  const request = requests.at(index);
  if (!request) {
    throw new Error("Rename transport missing");
  }
  request.answer.resolve(
    Response.json({
      entityId: request.entityId,
      name: request.name,
      file: { fieldId: `field-${request.entityId}`, fileName: request.name },
    }),
  );
};
afterEach(async () => {
  await act(async () => cleanup());
  requests.length = 0;
  useInspectorTabsStore.setState({ tabs: [], activeId: null });
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await unregisterDomEnvironment();
});
const edit = (scope: HTMLElement, name: string) => {
  const input = within(scope).getByRole("textbox");
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
};
const openMenuRename = async (scope: HTMLElement) => {
  fireEvent.click(
    within(scope).getByRole("button", { name: englishMessages.common.actions }),
  );
  await waitFor(() =>
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull(),
  );
  fireEvent.click(
    within(document.body).getByRole("menuitem", {
      name: englishMessages.common.rename,
    }),
  );
};

test("tree row completions clear each pending rename independently of refetch", async () => {
  const Rows = () => {
    const rename = useRenameEntity();
    const [editing, setEditing] = React.useState<string | null>(null);
    const [nodes, setNodes] = React.useState([entity("A"), entity("B")]);
    return (
      <>
        {nodes.map((node) => (
          <section data-testid={node.entityId} key={node.entityId}>
            <FilesystemRow
              node={{ ...node, children: [] }}
              depth={0}
              workspaceId="matter"
              extraColumns={[]}
              folderStatistics={undefined}
              gridTemplate="1fr 2rem"
              isFiltered={false}
              ancestorIds={new Set()}
              expandedIds={new Set()}
              selectedIds={new Set()}
              editingEntityId={editing}
              currentFolderId={undefined}
              onToggleFolder={() => undefined}
              onNavigateToFolder={() => undefined}
              onStartEditing={setEditing}
              onRename={(entityId, name, completion) =>
                rename.mutate(
                  { workspaceId: "matter", entityId, name },
                  {
                    onError: completion.onError,
                    onSuccess: () => {
                      setNodes((current) =>
                        current.map((entry) =>
                          entry.entityId === entityId
                            ? { ...entry, name }
                            : entry,
                        ),
                      );
                      completion.onSuccess();
                    },
                  },
                )
              }
              onClearSelection={() => undefined}
              onSelect={() => undefined}
              onSubfolderCreated={() => undefined}
              getSelectedDragItems={() => []}
              getSelectedEntities={() => []}
              getAncestorIds={() => []}
            />
          </section>
        ))}
      </>
    );
  };
  const view = await mount(Rows);
  const refresh = Promise.withResolvers<undefined>();
  const invalidate = spyOn(view.client, "invalidateQueries").mockReturnValue(
    refresh.promise,
  );
  try {
    await openMenuRename(view.getByTestId("A"));
    edit(view.getByTestId("A"), "new-A");
    await openMenuRename(view.getByTestId("B"));
    edit(view.getByTestId("B"), "new-B");
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(view.getByTestId("A").textContent).toContain("new-A.md");
    expect(view.getByTestId("B").textContent).toContain("new-B.md");
    await act(async () => confirm(1));
    await act(async () => refuse(0));
    await waitFor(() =>
      expect(view.getByTestId("A").textContent).toContain("A.md"),
    );
    expect(view.getByTestId("A").textContent).not.toContain("new-A.md");
    await openMenuRename(view.getByTestId("B"));
    expect(within(view.getByTestId("B")).getByRole("textbox")).toHaveProperty(
      "value",
      "new-B",
    );
  } finally {
    refresh.resolve(undefined);
    invalidate.mockRestore();
  }
});

test("breadcrumb pending label settles before file metadata refetch and refusal restores its editor", async () => {
  const view = await mount(() => (
    <ol>
      <PdfBreadcrumb />
    </ol>
  ));
  const refresh = Promise.withResolvers<undefined>();
  const invalidate = spyOn(view.client, "invalidateQueries").mockReturnValue(
    refresh.promise,
  );
  try {
    fireEvent.doubleClick(view.getByRole("link", { name: "A.md" }));
    edit(view.container, "new-A");
    await waitFor(() => expect(requests).toHaveLength(1));
    await waitFor(() =>
      expect(view.queryByRole("link", { name: "A.md" })).toBeNull(),
    );
    expect(view.container.textContent).toContain("new-A.md");
    await act(async () => confirm(0));
    await waitFor(() =>
      expect(view.getByRole("link", { name: "A.md" })).toBeDefined(),
    );
    fireEvent.doubleClick(view.getByRole("link", { name: "A.md" }));
    edit(view.container, "refused");
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => refuse(1));
    await waitFor(() =>
      expect(view.getByRole("link", { name: "A.md" })).toBeDefined(),
    );
    expect(invalidate).toHaveBeenCalledTimes(4);
  } finally {
    refresh.resolve(undefined);
    invalidate.mockRestore();
  }
});

test("kanban card commits close the editor and settle each tab with the real observer", async () => {
  for (const id of ["A", "B"]) {
    useInspectorTabsStore.getState().openFile({
      id: `field-${id}`,
      entityId: id,
      workspaceId: "matter",
      label: `${id}.md`,
      fileName: `${id}.md`,
      pdfFileId: null,
    });
  }
  const Cards = () => {
    const rename = useRenameEntity();
    return (
      <>
        {[entity("A"), entity("B")].map((entry) => (
          <section data-testid={entry.entityId} key={entry.entityId}>
            <KanbanCard
              entity={entry}
              workspaceId="matter"
              draggable={false}
              onRename={(entityId, name) =>
                rename.mutate({ workspaceId: "matter", entityId, name })
              }
            />
          </section>
        ))}
      </>
    );
  };
  const view = await mount(Cards);
  await openMenuRename(view.getByTestId("A"));
  edit(view.getByTestId("A"), "new-A.md");
  await openMenuRename(view.getByTestId("B"));
  edit(view.getByTestId("B"), "new-B.md");
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(view.queryByRole("textbox")).toBeNull();
  expect(view.getByTestId("A").textContent).toContain("A.md");
  await act(async () => confirm(1));
  await act(async () => refuse(0));
  await waitFor(() => expect(view.client.isMutating()).toBe(0));
  expect(useInspectorTabsStore.getState().tabs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entityId: "A",
        label: "A.md",
        fileName: "A.md",
      }),
      expect.objectContaining({
        entityId: "B",
        label: "new-B.md",
        fileName: "new-B.md",
      }),
    ]),
  );
});
