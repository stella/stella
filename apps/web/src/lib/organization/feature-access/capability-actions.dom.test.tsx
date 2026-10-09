import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import messages from "@/i18n/langs/en.json";

import { resolveActionCapabilities } from "./action-capabilities.logic";
import type { Capability } from "./action-capabilities.logic";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path.endsWith("/organization-settings/deepl")) {
      return Response.json({ configured: true });
    }
    if (path.endsWith("/document-translations/prepare")) {
      return Response.json({ entityVersionId: "version", hasComments: false });
    }
    return Response.json(null);
  },
  { preconnect: () => undefined },
);
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { ActionCapabilitiesProvider } = await import("./capability-actions");
const { Menu, MenuPopup } = await import("@stll/ui/menu");
const { RowFeatureMenuActions, RowOcrMenuActions } =
  await import("@/components/workspaces/row-actions");
const { TranslateDocumentDialog } =
  await import("@/components/translate-document-dialog");
const router = await import("@tanstack/react-router");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { toSafeId } = await import("@/lib/safe-id");
const { CommandActionItem } =
  await import("@/components/search-dialog-results");
const { COMMAND_ACTIONS } =
  await import("@/features/command-palette/lib/registry");
const { panic } = await import("better-result");
const commandAction = COMMAND_ACTIONS.find(
  (action) => action.id === "new-chat",
);
if (commandAction === undefined) {
  panic("New chat command fixture is missing");
}
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  return GlobalRegistrator.unregister();
});

const entity = {
  entityId: toSafeId<"entity">("entity"),
  kind: "document",
  name: "document",
  parentId: null,
  createdAt: "2025-01-01T00:00:00.000Z",
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
  fields: {},
} satisfies Parameters<typeof RowFeatureMenuActions>[0]["entity"];
const surfaces = [
  {
    name: "file context menu",
    capability: "deepl",
    surface: "menu",
    label: messages.common.translate,
  },
  {
    name: "document toolbar",
    capability: "translation",
    surface: "control",
    label: messages.common.translate,
  },
  {
    name: "row actions",
    capability: "ocr",
    surface: "menu",
    label: messages.workspaces.files.runOcr,
  },
  {
    name: "command palette",
    capability: "ai",
    surface: "control",
    label: "Run action",
  },
  {
    name: "chat insert",
    capability: "ai",
    surface: "menu",
    label: messages.chat.chatAbout,
  },
] as const satisfies readonly {
  name: string;
  capability: Capability;
  surface: "menu" | "control";
  label: string;
}[];
for (const fixture of surfaces) {
  describe(`${fixture.name} shared renderer admission`, () => {
    for (const role of ORGANIZATION_ROLE_NAMES) {
      for (const available of [false, true]) {
        test(`${role}: ${available ? "available action retains behavior" : "unavailable action cannot activate"}`, async () => {
          let calls = 0;
          const client = new QueryClient({
            defaultOptions: { queries: { retry: false } },
          });
          clients.push(client);
          const value = resolveActionCapabilities({
            role,
            ai: fixture.name === "document toolbar" ? false : available,
            deepl: available,
            ocr: available,
            desktop: available ? "current" : "none",
            settings: undefined,
          });
          const action = (() => {
            switch (fixture.name) {
              case "command palette":
                return (
                  <CommandActionItem
                    entry={{
                      type: "command-action",
                      title: "Run action",
                      action: {
                        ...commandAction,
                        title: "Run action",
                        keywordLabels: [],
                      },
                    }}
                    navigation={{ type: "button" }}
                    onSelect={() => {
                      calls += 1;
                    }}
                  />
                );
              case "document toolbar":
                return (
                  <TranslateDocumentDialog
                    workspaceId="matter"
                    viewId="view"
                    entityId="entity"
                    fieldId="field"
                    entityVersionKey="1"
                    isDocx
                  />
                );
              case "row actions":
                return (
                  <RowOcrMenuActions
                    canRunOcr
                    isPending={false}
                    onRun={async () => {
                      calls += 1;
                    }}
                    rowSources={[]}
                    selectedSource={undefined}
                  />
                );
              case "file context menu":
              case "chat insert":
                return (
                  <RowFeatureMenuActions
                    canCreateEntity
                    entity={entity}
                    file={null}
                    isBulk={false}
                    isFolder={false}
                    onChatAbout={() => {
                      calls += 1;
                    }}
                    onEditPages={undefined}
                    onOpenVersionHistory={undefined}
                    onSign={undefined}
                    onTranslate={() => {
                      calls += 1;
                    }}
                    signLabel="Sign"
                    translationTarget={
                      fixture.name === "file context menu"
                        ? {
                            encrypted: false,
                            fieldId: "field",
                            mimeType: "application/pdf",
                          }
                        : null
                    }
                  />
                );
              default:
                fixture satisfies never;
                return panic("Unexpected action fixture");
            }
          })();
          const root = router.createRootRoute({ component: router.Outlet });
          const protectedRoute = router.createRoute({
            getParentRoute: () => root,
            id: "_protected",
            beforeLoad: () => ({
              user: { activeOrganizationId: "organization-a" },
            }),
            component: router.Outlet,
          });
          const route = router.createRoute({
            getParentRoute: () => protectedRoute,
            path: "/",
            component: () =>
              fixture.surface === "menu" ? (
                <Menu open>
                  <MenuPopup>{action}</MenuPopup>
                </Menu>
              ) : (
                action
              ),
          });
          const appRouter = router.createRouter({
            history: router.createMemoryHistory({ initialEntries: ["/"] }),
            routeTree: root.addChildren([protectedRoute.addChildren([route])]),
            isServer: false,
          });
          await appRouter.load();
          render(
            <QueryClientProvider client={client}>
              <IntlProvider locale="en" messages={messages} timeZone="UTC">
                <ActionCapabilitiesProvider value={value}>
                  <FormattingProvider locale="en" timeZone="UTC">
                    <router.RouterProvider router={appRouter} />
                  </FormattingProvider>
                </ActionCapabilitiesProvider>
              </IntlProvider>
            </QueryClientProvider>,
          );
          const actionRole = fixture.surface === "menu" ? "menuitem" : "button";
          if (!available && value.role === "member") {
            expect(
              screen.queryByRole(actionRole, { name: fixture.label }),
            ).toBeNull();
            expect(screen.queryAllByRole("link")).toHaveLength(0);
            expect(calls).toBe(0);
            return;
          }
          const control = await screen.findByRole(actionRole, {
            name: fixture.label,
          });
          if (available) {
            expect(control.getAttribute("aria-disabled")).not.toBe("true");
            expect(screen.queryAllByRole("link")).toHaveLength(0);
            fireEvent.click(control);
            if (fixture.name === "document toolbar") {
              expect(await screen.findByRole("dialog")).toBeTruthy();
              await waitFor(() => {
                const provider = document.querySelector(
                  'input[value="translated:deepl"]',
                );
                expect(
                  provider instanceof HTMLInputElement && provider.checked,
                ).toBe(true);
              });
            } else {
              expect(calls).toBe(1);
            }
            return;
          }
          expect(control.getAttribute("aria-disabled")).toBe("true");
          const descriptionId = control.getAttribute("aria-describedby");
          expect(descriptionId).toBeTruthy();
          expect(
            document.querySelector(`#${CSS.escape(descriptionId ?? "")}`)
              ?.textContent?.length,
          ).toBeGreaterThan(0);
          const state = value.capabilities[fixture.capability];
          expect(state.type).toBe("unavailable");
          const settingsItems = screen.getAllByRole(
            fixture.surface === "menu" ? "menuitem" : "link",
            { name: messages.organization.aiConfig.configure, exact: true },
          );
          if (state.type === "unavailable") {
            expect(
              settingsItems.some(
                (item) => item.getAttribute("href") === state.settingsLink,
              ),
            ).toBe(true);
          }
          if (fixture.surface === "menu") {
            control.focus();
            fireEvent.keyDown(control, { key: "ArrowDown" });
            await waitFor(() =>
              expect(
                settingsItems.some((item) => item === document.activeElement),
              ).toBe(true),
            );
          }
          fireEvent.click(control);
          fireEvent.keyDown(control, { key: "Enter" });
          expect(calls).toBe(0);
          expect(screen.queryByRole("dialog")).toBeNull();
        });
      }
    }
  });
}
