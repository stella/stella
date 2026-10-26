import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { act, cleanup, render } = await import("@testing-library/react");
const { RouterProvider, useRouter } = await import("@tanstack/react-router");
const {
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

/** Renders the params a navigation into each matter would open under, and
 * the view on screen as the hook and the router snapshot each read it. */
const Probe = () => {
  const intoA = useWorkspaceViewParams(matterA);
  const intoB = useWorkspaceViewParams(matterB);
  const subscribed = useCurrentWorkspaceView();
  const router = useRouter();
  return (
    <>
      <output data-testid="params">{JSON.stringify({ intoA, intoB })}</output>
      <output data-testid="current">
        {JSON.stringify({
          subscribed: subscribed ?? null,
          snapshot: getCurrentWorkspaceView(router) ?? null,
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

describe("the view on screen", () => {
  const filesView = { workspaceId: matterA, viewId: filesViewId };

  test("is the matched view under a view and its document, read alike by the hook and the router", async () => {
    for (const path of [
      `/workspaces/${matterA}/${filesViewId}`,
      `/workspaces/${matterA}/${filesViewId}/document?entity=e`,
    ]) {
      expect(await currentViewAt(path)).toEqual({
        subscribed: filesView,
        snapshot: filesView,
      });
    }
  });

  test("is none on a matter page that is not a view, or outside any matter", async () => {
    for (const path of [
      `/workspaces/${matterA}/reports/export_1`,
      `/workspaces/${matterA}/correspondence/thread_1`,
      "/chat",
    ]) {
      expect(await currentViewAt(path)).toEqual({
        subscribed: null,
        snapshot: null,
      });
    }
  });
});
