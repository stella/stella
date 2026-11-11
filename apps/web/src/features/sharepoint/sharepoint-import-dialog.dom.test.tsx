import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  SHAREPOINT_ITEM_KIND,
  SHAREPOINT_REFUSAL_CODE,
} from "@stll/api-contract/sharepoint";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json" with { type: "json" };

GlobalRegistrator.register({
  url: "http://localhost:3000/workspaces/matter-fixture",
});
const originalFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { SharepointImportDialog } = await import("./sharepoint-import-dialog");

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const DRIVE = { id: "b!onedrive", name: "OneDrive", driveType: "business" };
const PARENT_ID = "0b6f2a4e-6a43-4a43-9a8e-0c1d2e3f4a5b";

const file = (id: string, name: string) => ({
  id,
  driveId: DRIVE.id,
  name,
  kind: SHAREPOINT_ITEM_KIND.file,
  size: 2048,
  mimeType: "application/pdf",
  lastModifiedAt: "2026-10-01T09:00:00Z",
  webUrl: null,
  eTag: null,
});

const ROOT_ITEMS = [
  {
    ...file("01PLEADINGS", "Pleadings"),
    kind: SHAREPOINT_ITEM_KIND.folder,
    size: null,
    mimeType: null,
  },
  file("01CLAIM", "Statement of claim.pdf"),
  file("01REPLY", "Reply.pdf"),
  {
    ...file("01NOTEBOOK", "Hearing notes"),
    kind: SHAREPOINT_ITEM_KIND.other,
    mimeType: null,
  },
];

type Connection =
  { status: "connected" | "reconnect_required" } | null | "unreadable";

const mount = ({ connection }: { connection: Connection }) => {
  const imports: unknown[] = [];
  const childrenRequests: string[] = [];
  let connectionReads = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (pathname.endsWith("/sharepoint/connection")) {
        connectionReads += 1;
        if (connection === "unreadable") {
          return Response.json(
            { code: "internal_server_error", message: "Database unavailable" },
            { status: 500 },
          );
        }
        return Response.json({
          connection:
            connection === null
              ? null
              : {
                  id: "connection",
                  status: connection.status,
                  scope: "Files.Read.All",
                  accountLabel: "lawyer@example.test",
                  expiresAt: null,
                  lastUsedAt: null,
                  createdAt: "2026-10-01T09:00:00Z",
                },
        });
      }
      if (pathname.endsWith("/sharepoint/sites")) {
        return Response.json({ items: [], nextCursor: null });
      }
      if (pathname.endsWith("/sharepoint/drives")) {
        return Response.json({ items: [DRIVE], nextCursor: null, limit: 100 });
      }
      if (
        pathname.includes("/sharepoint/drives/") &&
        pathname.endsWith("/children")
      ) {
        childrenRequests.push(pathname);
        return Response.json({
          items: pathname.includes("/items/root/") ? ROOT_ITEMS : [],
          nextCursor: null,
          limit: 100,
        });
      }
      if (
        request.method === "POST" &&
        pathname.includes("/sharepoint/imports/")
      ) {
        imports.push(await request.json());
        return Response.json({
          results: [
            {
              driveId: DRIVE.id,
              itemId: "01CLAIM",
              status: "created",
              entityId: "entity-1",
              name: "Statement of claim.pdf",
              versionNumber: 1,
            },
            {
              driveId: DRIVE.id,
              itemId: "01REPLY",
              status: "failed",
              code: SHAREPOINT_REFUSAL_CODE.fileTooLarge,
              message: "The file is larger than a stella document may be",
            },
          ],
        });
      }
      return Response.json(
        { message: `Unexpected request: ${pathname}` },
        { status: 500 },
      );
    },
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <TooltipProvider>
            <AuthenticatedUserProvider
              user={{
                activeOrganizationId: "organization-fixture",
                email: "lawyer@example.test",
                id: "user",
                image: null,
                name: "Lawyer",
                preferredName: null,
                timezoneId: "Europe/Prague",
                wordEditShortcut: null,
              }}
            >
              <SharepointImportDialog
                onOpenChange={() => undefined}
                open
                parentId={PARENT_ID}
                workspaceId="matter-fixture"
              />
            </AuthenticatedUserProvider>
          </TooltipProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { imports, childrenRequests, connectionReads: () => connectionReads };
};

const picker = messages.sharepoint.picker;

test("browses OneDrive, imports picked files into the open folder and lists each outcome", async () => {
  const server = mount({ connection: { status: "connected" } });

  fireEvent.click(
    await screen.findByRole("button", { name: picker.myOneDrive }),
  );
  fireEvent.click(await screen.findByRole("button", { name: DRIVE.name }));
  const claim = await screen.findByRole("checkbox", {
    name: "Statement of claim.pdf",
  });

  // A notebook is listed but cannot be picked; a folder opens instead.
  expect(screen.queryByRole("checkbox", { name: "Hearing notes" })).toBeNull();
  expect(screen.getByText(picker.notImportable)).toBeDefined();
  expect(screen.getByRole("button", { name: "Pleadings" })).toBeDefined();

  fireEvent.click(claim);
  fireEvent.click(screen.getByRole("checkbox", { name: "Reply.pdf" }));
  const importButton = screen.getByRole("button", {
    name: messages.common.import,
  });
  fireEvent.click(importButton);

  await waitFor(() => expect(server.imports).toHaveLength(1));
  expect(server.imports.at(0)).toEqual({
    items: [
      { driveId: DRIVE.id, itemId: "01CLAIM" },
      { driveId: DRIVE.id, itemId: "01REPLY" },
    ],
    parentId: PARENT_ID,
  });
  const results = await screen.findByText(
    messages.errors.apiCodes.sharepointFileTooLarge,
  );
  const failedRow = results.closest("li");
  expect(failedRow).not.toBeNull();
  expect(
    within(failedRow ?? document.body).getByText(messages.common.failed),
  ).toBeDefined();
  expect(screen.getByText(messages.sharepoint.import.created)).toBeDefined();
});

test("the breadcrumb returns from a folder to its drive's top level", async () => {
  const server = mount({ connection: { status: "connected" } });

  fireEvent.click(
    await screen.findByRole("button", { name: picker.myOneDrive }),
  );
  fireEvent.click(await screen.findByRole("button", { name: DRIVE.name }));
  fireEvent.click(await screen.findByRole("button", { name: "Pleadings" }));
  await screen.findByText(picker.emptyFolder);

  const breadcrumb = screen.getByRole("navigation");
  expect(
    within(breadcrumb).getByText("Pleadings").getAttribute("aria-current"),
  ).toBe("page");
  fireEvent.click(within(breadcrumb).getByRole("button", { name: DRIVE.name }));

  await screen.findByRole("checkbox", { name: "Statement of claim.pdf" });
  expect(
    server.childrenRequests.map((path) => path.slice(path.indexOf("/items/"))),
  ).toEqual(["/items/root/children", "/items/01PLEADINGS/children"]);
});

test("a member who has not connected is offered the connect action instead of the picker", async () => {
  mount({ connection: null });

  expect(await screen.findByText(picker.notConnected)).toBeDefined();
  expect(
    screen.getByRole("button", { name: messages.common.connect }),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: picker.myOneDrive })).toBeNull();
});

test("an expired Microsoft sign-in offers reconnect", async () => {
  mount({ connection: { status: "reconnect_required" } });

  expect(await screen.findByText(picker.reconnectRequired)).toBeDefined();
  expect(
    screen.getByRole("button", { name: messages.common.reconnect }),
  ).toBeDefined();
});

test("a connection status that cannot be read says so and offers a retry", async () => {
  const server = mount({ connection: "unreadable" });

  const retry = await screen.findByRole("button", {
    name: messages.common.retry,
  });
  expect(screen.getByText(messages.common.somethingWentWrong)).toBeDefined();
  expect(screen.queryByText(picker.notConnected)).toBeNull();
  expect(screen.queryByRole("button", { name: picker.myOneDrive })).toBeNull();

  fireEvent.click(retry);
  await waitFor(() => expect(server.connectionReads()).toBe(2));
});
