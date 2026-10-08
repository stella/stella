import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import type { TableTreeNode } from "@/components/workspaces/table/types";
import englishMessages from "@/i18n/langs/en.json";
import type { WorkspaceView } from "@/lib/types";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const workspaceId = "019a0000-0000-7000-8000-000000000101";
const viewId = "019a0000-0000-7000-8000-000000000106";
const currentFolderId = "019a0000-0000-7000-8000-000000000102";
const folderId = "019a0000-0000-7000-8000-000000000103";
const fileEntityId = "019a0000-0000-7000-8000-000000000104";
const filePropertyId = "019a0000-0000-7000-8000-000000000105";

type RecordedRequest = { method: string; pathname: string; body: unknown };
const requests: RecordedRequest[] = [];

const readBody = async (request: Request): Promise<unknown> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    return Object.fromEntries(
      [...(await request.formData()).entries()].filter(
        ([, value]) => typeof value === "string",
      ),
    );
  }
  const text = await request.text();
  return contentType.includes("application/json") && text !== ""
    ? JSON.parse(text)
    : text;
};

// The network is the only boundary: every drop below runs the real Files
// rows, drop zone and upload paths up to the request that names where the
// bytes go. That request is refused, so nothing continues past it.
const fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/api/auth/")) {
        return Response.json(null);
      }
      requests.push({
        method: request.method,
        pathname,
        body: await readBody(request),
      });
      // The matter has no file column yet; the upload path creates it first.
      if (request.method === "PUT" && pathname.startsWith("/v1/properties/")) {
        return Response.json({ id: filePropertyId });
      }
      return Response.json(
        { error: { code: "test_refused", message: "refused by test" } },
        { status: 422 },
      );
    },
    { preconnect: () => undefined },
  ),
);

const { act, cleanup, fireEvent, render, waitFor } =
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
const { rootKeys } = await import("@/lib/auth-queries");
const { toSafeId } = await import("@/lib/safe-id");
const { propertiesKeys } = await import("@/lib/workspaces/queries/properties");
const { viewsOptions } = await import("@/lib/workspaces/queries/views");
const { FilesystemRow } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view");
const { WorkspaceDropZone } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/workspace-drop-zone");

const entity = (
  entityId: string,
  kind: "folder" | "document",
  name: string,
): TableTreeNode => ({
  entityId: toSafeId<"entity">(entityId),
  kind,
  name,
  parentId: toSafeId<"entity">(currentFolderId),
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
  listItemType: null,
  dueDate: null,
  agendaKind: "task",
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
  cellMetadata: {},
  assignees: [],
  fields:
    kind === "folder"
      ? {}
      : {
          [filePropertyId]: {
            entityId: toSafeId<"entity">(entityId),
            id: toSafeId<"field">(`field-${entityId}`),
            propertyId: toSafeId<"property">(filePropertyId),
            content: {
              version: 1,
              type: "file",
              id: toSafeId<"userFile">(`file-${entityId}`),
              fileName: name,
              mimeType: "application/pdf",
              sizeBytes: 10,
              encrypted: false,
              sha256Hex: "0".repeat(64),
              pdfFileId: null,
            },
          },
        },
  children: [],
});

const folder = entity(folderId, "folder", "Pleadings");
const fileRow = entity(fileEntityId, "document", "contract.pdf");

const filesView = {
  id: viewId,
  version: 1,
  name: "Files",
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    type: "filesystem",
    version: 1,
    filters: [],
    sorts: [],
    hiddenProperties: [],
    calculations: [],
  },
} satisfies WorkspaceView;

const FilesView = () => (
  <WorkspaceDropZone workspaceId={workspaceId}>
    {[folder, fileRow].map((node) => (
      <FilesystemRow
        ancestorIds={new Set()}
        currentFolderId={currentFolderId}
        depth={0}
        editingEntityId={null}
        expandedIds={new Set()}
        extraColumns={[]}
        folderStatistics={undefined}
        getAncestorIds={() => []}
        getSelectedDragItems={() => []}
        getSelectedEntities={() => []}
        gridTemplate="1fr 2rem"
        isFiltered={false}
        key={node.entityId}
        node={node}
        onClearSelection={() => undefined}
        onNavigateToFolder={() => undefined}
        onRename={() => undefined}
        onSelect={() => undefined}
        onStartEditing={() => undefined}
        onSubfolderCreated={() => undefined}
        onToggleFolder={() => undefined}
        selectedIds={new Set()}
        workspaceId={workspaceId}
      />
    ))}
    <div data-testid="empty-space" />
  </WorkspaceDropZone>
);

const mountFilesView = async () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(rootKeys.role, "owner");
  client.setQueryData(propertiesKeys.all(workspaceId), []);
  client.setQueryData(viewsOptions(workspaceId).queryKey, [filesView]);
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
    beforeLoad: () => ({ user: { activeOrganizationId: "org-fixture" } }),
    component: Outlet,
  });
  const workspace = createRoute({
    getParentRoute: () => protectedRoute,
    path: "workspaces/$workspaceId",
    component: Outlet,
  });
  const view = createRoute({
    getParentRoute: () => workspace,
    path: "$viewId",
    validateSearch: (search: Record<string, unknown>) => ({
      folder: typeof search["folder"] === "string" ? search["folder"] : "",
    }),
    component: FilesView,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      protectedRoute.addChildren([workspace.addChildren([view])]),
    ]),
    history: createMemoryHistory({
      initialEntries: [
        `/workspaces/${workspaceId}/${viewId}?folder=${currentFolderId}`,
      ],
    }),
  });
  await router.load();
  const mounted = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: "org-fixture",
              id: "user-fixture",
              email: "member@example.test",
              image: null,
              name: "Fixture member",
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
  await waitFor(() =>
    expect(document.querySelectorAll("[data-entity-row]")).toHaveLength(2),
  );
  return { mounted, client };
};

const rowNamed = (name: string): HTMLElement => {
  const row = [
    ...document.querySelectorAll<HTMLElement>("[data-entity-row]"),
  ].find((element) => element.textContent?.includes(name));
  if (!row) {
    throw new Error(`No Files row named ${name}`);
  }
  return row;
};

/** The row's own surface carries its drop highlight. */
const isHighlighted = (row: HTMLElement): boolean =>
  row.firstElementChild?.classList.contains("bg-accent") ?? false;

const osFileTransfer = (file: File) => ({
  types: ["Files"],
  items: [{ kind: "file", type: file.type, getAsFile: () => file }],
  files: [file],
  getData: () => "",
  setData: () => undefined,
  setDragImage: () => undefined,
  dropEffect: "none",
  effectAllowed: "all",
});

const dispatchDrag = (
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  target: Element,
  dataTransfer: ReturnType<typeof osFileTransfer>,
  relatedTarget: Element | null = null,
) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    relatedTarget: { value: relatedTarget },
    clientX: { value: 1 },
    clientY: { value: 1 },
  });
  act(() => {
    target.dispatchEvent(event);
  });
};

/** An OS file drag enters the window over `target` and hovers it. */
const hoverWithOsFile = (target: Element, file: File) => {
  const transfer = osFileTransfer(file);
  dispatchDrag("dragenter", target, transfer);
  dispatchDrag("dragover", target, transfer);
  return transfer;
};

// Every new-file upload from a drop first asks the API to place the dropped
// files under one parent; that request is where a wrong target shows.
const uploadParentIds = () =>
  requests
    .filter(({ pathname }) => pathname.endsWith("/entity-create/tree"))
    .map(({ body }) =>
      typeof body === "object" && body !== null && "parentId" in body
        ? body.parentId
        : undefined,
    );

afterEach(async () => {
  await act(async () => cleanup());
  requests.length = 0;
});
afterAll(async () => {
  fetchBoundary.mockRestore();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await GlobalRegistrator.unregister();
});

describe("OS file drops in the Files view", () => {
  test("a file dropped on a folder row uploads into that folder", async () => {
    const { client } = await mountFilesView();
    const folderRow = rowNamed("Pleadings");
    const file = new File(["brief"], "brief.txt", { type: "text/plain" });

    const transfer = hoverWithOsFile(folderRow, file);
    expect(isHighlighted(folderRow)).toBe(true);
    dispatchDrag("drop", folderRow, transfer);

    expect(isHighlighted(folderRow)).toBe(false);
    await waitFor(() => expect(uploadParentIds()).toEqual([folderId]));
    client.clear();
  });

  test("moving off a folder row clears its highlight without uploading", async () => {
    const { mounted, client } = await mountFilesView();
    const folderRow = rowNamed("Pleadings");
    const emptySpace = mounted.getByTestId("empty-space");
    const file = new File(["brief"], "brief.txt", { type: "text/plain" });

    const transfer = hoverWithOsFile(folderRow, file);
    expect(isHighlighted(folderRow)).toBe(true);
    dispatchDrag("dragenter", emptySpace, transfer, folderRow);
    dispatchDrag("dragover", emptySpace, transfer, folderRow);
    expect(isHighlighted(folderRow)).toBe(false);

    dispatchDrag("dragenter", folderRow, transfer, emptySpace);
    dispatchDrag("dragover", folderRow, transfer, emptySpace);
    expect(isHighlighted(folderRow)).toBe(true);
    // The drag leaves the window: nothing stays highlighted, nothing uploads.
    dispatchDrag("dragleave", folderRow, transfer);
    expect(isHighlighted(folderRow)).toBe(false);
    expect(requests).toEqual([]);
    client.clear();
  });

  test("a file dropped on empty space uploads into the current folder", async () => {
    const { mounted, client } = await mountFilesView();
    const emptySpace = mounted.getByTestId("empty-space");
    const file = new File(["brief"], "brief.txt", { type: "text/plain" });

    const transfer = hoverWithOsFile(emptySpace, file);
    expect(isHighlighted(rowNamed("Pleadings"))).toBe(false);
    expect(isHighlighted(rowNamed("contract.pdf"))).toBe(false);
    dispatchDrag("drop", emptySpace, transfer);

    await waitFor(() => expect(uploadParentIds()).toEqual([currentFolderId]));
    client.clear();
  });

  test("a file dropped on a file row still offers a new version of it", async () => {
    const { mounted, client } = await mountFilesView();
    const row = rowNamed("contract.pdf");
    const file = new File(["v2"], "contract-v2.pdf", {
      type: "application/pdf",
    });

    const transfer = hoverWithOsFile(row, file);
    expect(isHighlighted(row)).toBe(true);
    dispatchDrag("drop", row, transfer);

    const messages = englishMessages.workspaces.files.versionOrNewFile;
    // The new-file option appears once the dialog has decided.
    await mounted.findByRole("button", { name: messages.createNewOption });
    expect(uploadParentIds()).toEqual([]);
    fireEvent.click(
      mounted.getByRole("button", { name: messages.replaceOption }),
    );

    await waitFor(() =>
      expect(
        requests
          .filter(({ pathname }) => pathname.endsWith("/upload-version"))
          .map(({ body }) => body),
      ).toEqual([{ entityId: fileEntityId }]),
    );
    expect(uploadParentIds()).toEqual([]);
    client.clear();
  });
});
