import type React from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RowSelectionState } from "@tanstack/react-table";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import {
  TEXT_FIELD_TYPE,
  TEXT_ABSENCE_REASON,
} from "@stll/api-contract/case-law-text-field";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { workspaceTableFeatures } from "@/components/workspaces/table/table-features";
import type {
  TableTreeNode,
  DecisionRowData,
} from "@/components/workspaces/table/types";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { useState, useRef } = await import("react");
const { useTable } = await import("@tanstack/react-table");
const { QueryClient, QueryClientProvider, onlineManager } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { PublicLawRow } =
  await import("@/components/public-law-table/public-law-row");
const { DraggableRow } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/table/entity-row-cells");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { propertiesOptions } =
  await import("@/lib/workspaces/queries/properties");
const { toSafeId } = await import("@/lib/safe-id");
const { selectColId } = await import("./workspace-table/internals-helpers");

const wasOnline = onlineManager.isOnline();
onlineManager.setOnline(false);

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  useInspectorTabsStore.setState(useInspectorTabsStore.getInitialState());
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  onlineManager.setOnline(wasOnline);
  await GlobalRegistrator.unregister();
});

// Derive the host census from imports, so a new host automatically exercises
// the selection/row boundary rather than relying on a maintained fixture list.
const selectionHosts: string[] = [];
for await (const path of new Bun.Glob("**/*.tsx").scan({
  cwd: new URL("../../../", import.meta.url).pathname,
})) {
  if (path.endsWith(".test.tsx")) {
    continue;
  }
  const source = await Bun.file(
    new URL(`../../../${path}`, import.meta.url),
  ).text();
  if (
    source.includes('from "@/components/workspaces/table/select-row-content"')
  ) {
    selectionHosts.push(path);
  }
}

const decisions = Array.from(
  { length: 4 },
  (_, index) =>
    ({
      kind: "decision",
      children: [],
      decision: {
        id: `decision-${index}`,
        caseNumber: "1/2026",
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        ecli: null,
        court: "Court",
        courtAbbreviation: null,
        country: "CZ",
        language: "cs",
        languageAlternates: [],
        slug: null,
        decisionDate: "2026-01-01",
        decisionType: null,
        headline: null,
        headnote: {
          type: TEXT_FIELD_TYPE.ABSENT,
          reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
        },
        citationCount: 0,
      },
    }) satisfies DecisionRowData,
);

const entities: TableTreeNode[] = Array.from(
  { length: 4 },
  (_, index) =>
    ({
      entityId: toSafeId<"entity">(`task-${index}`),
      kind: "task",
      name: `Task ${index}`,
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
      fields: {},
      cellMetadata: {},
      assignees: [],
      children: [],
    }) satisfies TableTreeNode,
);

const columns = [{ id: selectColId }];

const PublicLawFixture = ({ onOpen }: { onOpen: () => void }) => {
  const [rowSelection, onRowSelectionChange] = useState<RowSelectionState>({});
  const lastSelectedIndex = useRef<number | null>(null);
  const table = useTable({
    features: workspaceTableFeatures,
    data: decisions,
    columns,
    getRowId: ({ decision }) => decision.id,
    state: { rowSelection },
    onRowSelectionChange,
  });
  return table
    .getRowModel()
    .rows.map((row, index) => (
      <PublicLawRow
        key={row.id}
        row={row}
        index={index}
        rowLabel={String(index + 1)}
        renderColumns={table.getVisibleLeafColumns()}
        addPropertyColumn={null}
        table={table}
        contentMode="tight"
        expandedCellId={null}
        hasExpandedTableCell={false}
        lastSelectedIndex={lastSelectedIndex}
        measureElement={() => undefined}
        onToggleExpandedCell={() => undefined}
        isActive={false}
        onOpen={onOpen}
      />
    ));
};

const EntityFixture = () => {
  const [rowSelection, onRowSelectionChange] = useState<RowSelectionState>({});
  const lastSelectedIndex = useRef<number | null>(null);
  const table = useTable({
    features: workspaceTableFeatures,
    data: entities,
    columns,
    getRowId: ({ entityId }) => entityId,
    state: { rowSelection },
    onRowSelectionChange,
  });
  return table
    .getRowModel()
    .rows.map((row, index) => (
      <DraggableRow
        key={row.id}
        row={row}
        index={index}
        rowLabel={String(index + 1)}
        renderColumns={table.getVisibleLeafColumns()}
        addPropertyColumn={null}
        table={table}
        contentMode="tight"
        expandedCellId={null}
        hasExpandedTableCell={false}
        lastSelectedIndex={lastSelectedIndex}
        measureElement={() => undefined}
        onToggleExpandedCell={() => undefined}
        workspaceId="selection-test"
        activeEntityId={null}
        activePropertyId={null}
        activeTaskId={null}
        editingEntityId={null}
        onRename={() => undefined}
        onStartEditing={() => undefined}
        onStopEditing={() => undefined}
      />
    ));
};

const fixtures = new Map<string, React.ComponentType<{ onOpen: () => void }>>([
  ["components/public-law-table/public-law-row.tsx", PublicLawFixture],
  [
    "routes/_protected.workspaces/$workspaceId/-components/table/entity-row-cells.tsx",
    EntityFixture,
  ],
]);

const renderHost = async (host: string) => {
  const Fixture = fixtures.get(host);
  if (!Fixture) {
    throw new Error(`No selection-column fixture for ${host}`);
  }
  let openCount = 0;
  const initialTabs = useInspectorTabsStore.getState().tabs;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(propertiesOptions("selection-test").queryKey, []);
  clients.push(client);
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user: { activeOrganizationId: "organization" } }),
    component: () => (
      <ChatEditorProvider>
        <div role="grid">
          <Fixture
            onOpen={() => {
              openCount++;
            }}
          />
        </div>
      </ChatEditorProvider>
    ),
  });
  const appRouter = router.createRouter({
    routeTree: root.addChildren([protectedRoute]),
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
  });
  await appRouter.load();
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <QueryClientProvider client={client}>
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: "organization",
              id: "user",
              email: "test@example.test",
              name: "Selection tester",
              image: null,
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <router.RouterProvider router={appRouter} />
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </QueryClientProvider>
    </IntlProvider>,
  );
  await view.findByRole("checkbox", { name: "1" });
  return {
    view,
    assertOpened: () => {
      expect(
        openCount +
          useInspectorTabsStore.getState().tabs.length -
          initialTabs.length,
      ).toBe(1);
    },
    assertNotOpened: () => {
      expect(openCount).toBe(0);
      expect(useInspectorTabsStore.getState().tabs).toEqual(initialTabs);
    },
  };
};

describe("every shared selection-column host", () => {
  test("the exercised host set equals the imports in product source", () => {
    expect(selectionHosts.toSorted()).toEqual([...fixtures.keys()].toSorted());
  });
  for (const host of selectionHosts) {
    test(`${host}: number and empty cell clicks select without opening the row`, async () => {
      const { view, assertNotOpened, assertOpened } = await renderHost(host);
      const first = view.getByRole("checkbox", { name: "1" });
      fireEvent.click(view.getByText("1"));
      expect(first.getAttribute("aria-checked")).toBe("true");
      assertNotOpened();
      fireEvent.click(first);
      expect(first.getAttribute("aria-checked")).toBe("false");
      assertNotOpened();
      const row = first.closest('[role="row"]');
      if (!row) {
        throw new Error("selection host did not render a row");
      }
      fireEvent.click(row);
      assertOpened();
    });
    test(`${host}: the number and checkbox sit on the first text line, not the row's middle`, async () => {
      const { view } = await renderHost(host);
      const number = view.getByText("1");
      expect(number.dataset["slot"]).toBe("table-row-number");
      const checkboxSlot = view
        .getByRole("checkbox", { name: "1" })
        .querySelector('[data-slot="checkbox"]')?.parentElement;
      for (const slot of [number, checkboxSlot]) {
        const classes = slot?.className.split(" ") ?? [];
        expect(classes).toContain("top-2");
        expect(classes).toContain("h-5");
        expect(classes).not.toContain("inset-0");
      }
    });
    test(`${host}: checkbox clicks toggle once and shift-click selects a range`, async () => {
      const { view, assertNotOpened } = await renderHost(host);
      const first = view.getByRole("checkbox", { name: "1" });
      const indicator = first.querySelector('[data-slot="checkbox"]');
      if (!indicator) {
        throw new Error("selection indicator is missing");
      }
      fireEvent.click(indicator);
      expect(first.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(view.getByRole("checkbox", { name: "4" }), {
        shiftKey: true,
      });
      expect(view.getAllByRole("checkbox", { checked: true })).toHaveLength(4);
      assertNotOpened();
    });
  }
});
