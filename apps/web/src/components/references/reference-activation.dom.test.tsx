import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const {
  createMatterViewTestRouter,
  EXPECTED_OTHER_TREE_REVEAL,
  seedTestMatterTrees,
  TEST_FOLDER_ID,
  TEST_MATTER_ID,
  TEST_OTHER_TREE_DOCUMENT_PATH,
} = await import("@/lib/workspaces/matter-view-test-router");
// Activation reads the entity it names; the fixture folder is the only one.
const fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(new Request(input, init).url);
      if (pathname.endsWith(`/${TEST_FOLDER_ID}`)) {
        return Response.json({ kind: "folder", name: "Pleadings", fields: [] });
      }
      throw new TypeError(`Unexpected reference request: ${pathname}`);
    },
    { preconnect: () => undefined },
  ),
);
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { RouterProvider } = await import("@tanstack/react-router");
const { useReferenceActivation } =
  await import("@/components/references/reference-chip");

afterEach(cleanup);
afterAll(async () => {
  fetchBoundary.mockRestore();
  await unregisterDomEnvironment();
});

/** A control that lists references in its own shell and opens them as a
 * chip does. */
const folderReference = {
  type: "entity",
  entityId: TEST_FOLDER_ID,
  entityKind: "folder",
  label: "Pleadings",
  matterId: TEST_MATTER_ID,
  mimeType: null,
} as const;

const FolderReference = () => {
  const activate = useReferenceActivation(folderReference);
  return (
    <button onClick={activate} type="button">
      {folderReference.label}
    </button>
  );
};

test("an activated folder reference reveals the folder in the tree on screen, not the first tree", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seedTestMatterTrees(queryClient);
  const router = await createMatterViewTestRouter(
    TEST_OTHER_TREE_DOCUMENT_PATH,
    FolderReference,
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Pleadings" }));

  await waitFor(() =>
    expect({
      pathname: router.state.location.pathname,
      search: router.state.location.search,
    }).toEqual(EXPECTED_OTHER_TREE_REVEAL),
  );
});
