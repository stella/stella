import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { act, cleanup, render } = await import("@testing-library/react");
const { RouterProvider, useRouter } = await import("@tanstack/react-router");
const {
  getCurrentWorkspaceDocument,
  getCurrentWorkspaceView,
  useCurrentWorkspaceView,
  useWorkspaceViewParams,
} = await import("@/lib/workspaces/use-workspace-view-params");
const { DEFAULT_WORKSPACE_VIEW_ID } =
  await import("@/lib/workspaces/view-params.logic");
const {
  createMatterViewTestRouter,
  TEST_FILES_VIEW_ID: filesViewId,
  TEST_MATTER_ID: matterA,
} = await import("@/lib/workspaces/matter-view-test-router");

const matterB = "019a0000-0000-7000-8000-000000000302";

/** Renders the params a navigation into each matter would open under, the
 * view on screen as the hook and the router snapshot each read it, and the
 * document page on screen. */
const Probe = () => {
  const intoA = useWorkspaceViewParams(matterA);
  const intoB = useWorkspaceViewParams(matterB);
  const subscribed = useCurrentWorkspaceView();
  const { matches } = useRouter().state;
  return (
    <>
      <output data-testid="params">{JSON.stringify({ intoA, intoB })}</output>
      <output data-testid="current">
        {JSON.stringify({
          subscribed: subscribed ?? null,
          snapshot: getCurrentWorkspaceView(matches) ?? null,
          document: getCurrentWorkspaceDocument(matches) ?? null,
        })}
      </output>
    </>
  );
};

const mount = async (initialEntry: string) =>
  render(
    <RouterProvider
      router={await createMatterViewTestRouter(initialEntry, Probe)}
    />,
  );

const mountAt = async (initialEntry: string) =>
  (await (await mount(initialEntry)).findByTestId("params")).textContent;

const currentViewAt = async (initialEntry: string) => {
  const mounted = await mount(initialEntry);
  const current: unknown = JSON.parse(
    (await mounted.findByTestId("current")).textContent,
  );
  await act(async () => cleanup());
  return current;
};

afterEach(async () => {
  await act(async () => cleanup());
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

describe("the view a matter navigation opens under", () => {
  test("keeps the view on screen for its matter, under the view and its document", async () => {
    const expected = {
      intoA: { workspaceId: matterA, viewId: filesViewId },
      intoB: { workspaceId: matterB, viewId: DEFAULT_WORKSPACE_VIEW_ID },
    };
    expect(await mountAt(`/workspaces/${matterA}/${filesViewId}`)).toBe(
      JSON.stringify(expected),
    );
    await act(async () => cleanup());
    expect(
      await mountAt(`/workspaces/${matterA}/${filesViewId}/document?entity=e`),
    ).toBe(JSON.stringify(expected));
  });

  test("opens every matter under its default view off any matter view", async () => {
    expect(await mountAt("/chat")).toBe(
      JSON.stringify({
        intoA: { workspaceId: matterA, viewId: DEFAULT_WORKSPACE_VIEW_ID },
        intoB: { workspaceId: matterB, viewId: DEFAULT_WORKSPACE_VIEW_ID },
      }),
    );
  });
});

describe("the page on screen", () => {
  const filesView = { workspaceId: matterA, viewId: filesViewId };
  const offView = { subscribed: null, snapshot: null, document: null };

  test("a view root names its view and no document", async () => {
    expect(
      await currentViewAt(`/workspaces/${matterA}/${filesViewId}`),
    ).toEqual({ subscribed: filesView, snapshot: filesView, document: null });
  });

  test("a document page names its view, matter, entity and field", async () => {
    expect(
      await currentViewAt(
        `/workspaces/${matterA}/${filesViewId}/document?entity=e&field=f`,
      ),
    ).toEqual({
      subscribed: filesView,
      snapshot: filesView,
      document: { workspaceId: matterA, entityId: "e", fieldId: "f" },
    });
  });

  test("a matter page that is not a view names neither, even when its path ends in /document", async () => {
    for (const path of [
      `/workspaces/${matterA}/reports/export_1`,
      `/workspaces/${matterA}/reports/document`,
      `/workspaces/${matterA}/correspondence/document`,
      "/chat",
    ]) {
      expect({ path, current: await currentViewAt(path) }).toEqual({
        path,
        current: offView,
      });
    }
  });
});
