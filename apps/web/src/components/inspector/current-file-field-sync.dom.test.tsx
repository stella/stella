import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { FileTab } from "./file-tab";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const previousFetch = globalThis.fetch;
// The entity is seeded; a refetch of it stays in flight for the whole test.
globalThis.fetch = Object.assign(
  async () => await Promise.withResolvers<Response>().promise,
  { preconnect: previousFetch.preconnect },
);
const { act, cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { CurrentFileFieldSync } = await import("./current-file-field-sync");
const { useInspectorTabsStore } = await import("./inspector-tabs-store");
const { APIError } = await import("@/lib/errors/api");
const { fileContentQueryKey } =
  await import("@/lib/files/file-metadata-query.logic");
const { entityOptions } = await import("@/lib/workspaces/queries/entities");

const WORKSPACE_ID = "workspace-1";
const ENTITY_ID = "entity-1";
const FIELD_ID = "field-deleted";
const PROPERTY_ID = "property-1";

const TAB = {
  entityId: ENTITY_ID,
  fileName: "Lease.pdf",
  id: FIELD_ID,
  label: "Lease.pdf",
  pdfFileId: null,
  propertyId: PROPERTY_ID,
  type: "pdf",
  workspaceId: WORKSPACE_ID,
} as const;

const { propertyId: _propertyId, ...TAB_WITHOUT_PROPERTY } = TAB;

const DISPLAY_KEY = fileContentQueryKey({
  fieldId: FIELD_ID,
  workspaceId: WORKSPACE_ID,
});

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(async () => {
  await act(async () => cleanup());
  for (const client of clients.splice(0)) {
    client.clear();
  }
  useInspectorTabsStore.setState({ activeId: null, tabs: [] });
});
afterAll(async () => {
  globalThis.fetch = previousFetch;
  await unregisterDomEnvironment();
});

const fileField = (id: string) => ({
  content: {
    fileName: "Lease v2.pdf",
    mimeType: "application/pdf",
    type: "file",
  },
  id,
  propertyId: PROPERTY_ID,
});

/** Mounts the sync over an entity holding `fields`, its file read settled. */
const mountSync = async ({
  fields,
  fileKey = DISPLAY_KEY,
  fileResponds,
  isEntityRefreshing = false,
  isFieldIdPinned = false,
  tab = TAB,
}: {
  fields: readonly ReturnType<typeof fileField>[];
  fileKey?: readonly unknown[];
  fileResponds: boolean;
  isEntityRefreshing?: boolean;
  isFieldIdPinned?: boolean;
  tab?: FileTab;
}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const entityKey: readonly unknown[] = entityOptions(
    WORKSPACE_ID,
    ENTITY_ID,
  ).queryKey;
  client.setQueryData(entityKey, { fields });
  if (isEntityRefreshing) {
    // Stale on mount, so the observer refetches into the never-settling fetch.
    await client.invalidateQueries({
      queryKey: entityKey,
      refetchType: "none",
    });
  }
  const readFile = async () => {
    if (fileResponds) {
      return await Promise.resolve("file");
    }
    throw new APIError({ message: "File not found", status: 404 });
  };
  await client.prefetchQuery({ queryFn: readFile, queryKey: fileKey });
  useInspectorTabsStore.setState({ activeId: FIELD_ID, tabs: [tab] });
  render(
    <QueryClientProvider client={client}>
      <CurrentFileFieldSync
        isActive
        isFieldIdPinned={isFieldIdPinned}
        tab={tab}
      />
    </QueryClientProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return useInspectorTabsStore.getState().tabs.map(({ id }) => id);
};

test("closes the tab of a deleted file field that left no successor", async () => {
  expect(await mountSync({ fields: [], fileResponds: false })).toEqual([]);
});

test("keeps the tab of an older version whose file still loads", async () => {
  expect(await mountSync({ fields: [], fileResponds: true })).toEqual([
    FIELD_ID,
  ]);
});

test("keeps the tab while its field is being edited", async () => {
  expect(
    await mountSync({
      fields: [],
      fileResponds: false,
      isFieldIdPinned: true,
    }),
  ).toEqual([FIELD_ID]);
});

test("moves the tab to the field that replaced the deleted one", async () => {
  expect(
    await mountSync({
      fields: [fileField("field-current")],
      fileResponds: false,
    }),
  ).toEqual(["field-current"]);
});

test("closes the tab when the text viewer found the file missing", async () => {
  expect(
    await mountSync({
      fields: [],
      fileKey: ["files", "text", WORKSPACE_ID, FIELD_ID],
      fileResponds: false,
    }),
  ).toEqual([]);
});

test("waits for an entity refresh that may bring the replacement", async () => {
  expect(
    await mountSync({
      fields: [],
      fileResponds: false,
      isEntityRefreshing: true,
    }),
  ).toEqual([FIELD_ID]);
});

test("keeps a tab with no known property while the entity holds another file", async () => {
  expect(
    await mountSync({
      fields: [fileField("field-other")],
      fileResponds: false,
      tab: TAB_WITHOUT_PROPERTY,
    }),
  ).toEqual([FIELD_ID]);
});

test("closes a tab with no known property once the entity holds no file", async () => {
  expect(
    await mountSync({
      fields: [],
      fileResponds: false,
      tab: TAB_WITHOUT_PROPERTY,
    }),
  ).toEqual([]);
});
