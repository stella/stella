import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/inbox" });

const testing = await import("@testing-library/react");
const { QueryClient } = await import("@tanstack/react-query");
const { renderToString } = await import("react-dom/server");
const { hydrateRoot } = await import("react-dom/client");
const { PendingCacheScope } = await import("@/components/pending-cache");
const { entityViewLayoutsKey } =
  await import("@/lib/workspaces/queries/entity-view-layouts-key.logic");
const { useConfigStore } = await import("@/stores/config-store");
const { InboxPending } = await import("./-inbox.pending");

const ORGANIZATION_ID = "00000000-0000-7000-8000-00000000ffff";
const USER_ID = "00000000-0000-7000-8000-00000000fffe";

const initialInbox = useConfigStore.getState().inbox;

afterEach(() => {
  testing.cleanup();
  useConfigStore.setState({ inbox: initialInbox });
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const baseLayout = {
  version: 1,
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
} as const;

const savedTable = {
  version: 1,
  id: "view-deadlines",
  name: "Deadlines",
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    ...baseLayout,
    type: "table",
    hiddenProperties: ["_priority"],
    columnOrder: [],
    columnPinning: [],
  },
} as const;

const savedBoard = {
  ...savedTable,
  id: "view-board",
  name: "Board",
  position: 1,
  layout: { ...baseLayout, type: "kanban", groupByPropertyId: "_status" },
} as const;

/** A cache that holds the member's saved views, as an earlier visit left it. */
const cacheWith = (items: readonly unknown[]) => {
  const cache = new QueryClient();
  cache.setQueryData(entityViewLayoutsKey(ORGANIZATION_ID, USER_ID), {
    items,
  });
  return cache;
};

const tablePending = (root: ParentNode) =>
  root.querySelector('[data-slot="entity-view-table-pending"]');
const boardPending = (root: ParentNode) =>
  root.querySelector('[data-slot="entity-view-kanban-pending"]');
const gridHeads = (root: ParentNode) =>
  root.querySelectorAll('[data-slot="workspace-grid-head"]');

test("a member whose first saved view is a table gets the table, not a board", () => {
  // Both layouts are saved, so the inbox opens on the first saved view.
  const { container } = testing.render(
    <PendingCacheScope client={cacheWith([savedTable, savedBoard])}>
      <InboxPending />
    </PendingCacheScope>,
  );
  expect(tablePending(container)).not.toBeNull();
  expect(boardPending(container)).toBeNull();
  // Every inbox column but the hidden priority, a head each, then the
  // filler's head after them.
  expect(gridHeads(container).length).toBe(7 + 1);
  // The strip's two tabs, by the saved names.
  expect(container.textContent).toContain("Deadlines");
  expect(container.textContent).toContain("Board");
});

test("a member with no saved board opens on the default board, whatever else is saved", () => {
  const { container } = testing.render(
    <PendingCacheScope client={cacheWith([savedTable])}>
      <InboxPending />
    </PendingCacheScope>,
  );
  expect(boardPending(container)).not.toBeNull();
  expect(tablePending(container)).toBeNull();
  // The status columns and the uncategorized one, each with its header.
  expect(container.querySelectorAll("[data-kanban-column-header]").length).toBe(
    6,
  );
});

test("a cold load claims no body on the server's paint, then draws the one this browser kept", async () => {
  useConfigStore.setState({
    inbox: {
      organizationId: ORGANIZATION_ID,
      viewId: "view-deadlines",
      layout: {
        type: "table",
        groupByPropertyId: null,
        hiddenProperties: [],
        columnOrder: [],
        columnPinning: [],
      },
    },
  });
  const tree = <InboxPending />;
  const container = document.createElement("div");
  // safe-html: React renderToString output of the local pending view.
  container.innerHTML = renderToString(tree);
  expect(tablePending(container)).toBeNull();
  expect(boardPending(container)).toBeNull();
  document.body.append(container);
  const errors: unknown[] = [];
  const root = hydrateRoot(container, tree, {
    onRecoverableError: (error) => {
      errors.push(error);
    },
  });
  try {
    await testing.waitFor(() => {
      expect(tablePending(container) !== null).toBe(true);
    });
    expect(errors).toEqual([]);
    // All eight inbox columns, then the filler's head.
    expect(gridHeads(container).length).toBe(8 + 1);
  } finally {
    await testing.act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

test("without saved views or a kept layout, the body stays empty", () => {
  const { container } = testing.render(<InboxPending />);
  expect(tablePending(container)).toBeNull();
  expect(boardPending(container)).toBeNull();
  // Two tab names' worth of bars where the strip goes.
  expect(
    container.querySelectorAll('[data-slot="face-label-skeleton"]').length,
  ).toBe(2);
});
