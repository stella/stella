import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RouteComponent } from "@tanstack/react-router";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import path from "node:path";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const testing = await import("@testing-library/react");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { isFramePendingView } = await import("@/routes/-pending-view.logic");

afterEach(() => {
  testing.cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const SRC_DIR = path.resolve(import.meta.dir, "..");

// Every pending view the cold-load frame may draw. The server paints it as
// HTML and the client hydrates that paint, so markup the HTML parser rebuilds
// (a block inside a paragraph closes the paragraph) fails hydration.
const framePendingViews = async () => {
  const views: { name: string; view: RouteComponent }[] = [];
  const glob = new Bun.Glob("**/*.pending.tsx");
  for await (const file of glob.scan({ cwd: SRC_DIR })) {
    const module: Record<string, unknown> = await import(
      path.join(SRC_DIR, file)
    );
    for (const [exportName, value] of Object.entries(module)) {
      if (isFramePendingView(value)) {
        views.push({ name: `${file}#${exportName}`, view: value });
      }
    }
  }
  return views;
};

const views = await framePendingViews();

test("the frame draws at least the guidance reader's pending view", () => {
  expect(views.map((entry) => entry.name)).toContain(
    "routes/-guidance-reader.pending.tsx#GuidanceReaderPending",
  );
});

test.each(views)(
  "$name renders markup the HTML parser keeps as is",
  async ({ view: View }) => {
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: createRootRoute({
        component: () => (
          <div data-testid="frame-pending-view">
            <View />
          </div>
        ),
      }),
    });
    await router.load();
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = testing.render(<RouterProvider router={router} />);
      expect(result.getByTestId("frame-pending-view")).toBeTruthy();
      const nestingErrors = consoleError.mock.calls
        .map((call) => call.map(String).join(" "))
        .filter((message) => message.startsWith("In HTML, "));
      expect(nestingErrors).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  },
);
