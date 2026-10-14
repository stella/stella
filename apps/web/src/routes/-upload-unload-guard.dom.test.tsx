import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  resetActiveUploadsForTests,
  retainActiveUpload,
} from "@/lib/files/active-uploads";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, render } = await import("@testing-library/react");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { hasUnsavedWork } = await import("@/hooks/use-unsaved-work");
const { UploadUnloadGuard } = await import("./-upload-unload-guard");

const renderGuard = async () => {
  const root = createRootRoute({ component: UploadUnloadGuard });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
};

afterEach(() => {
  cleanup();
  resetActiveUploadsForTests();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("an in-flight upload is unsaved work until the batch releases", async () => {
  await renderGuard();
  expect(hasUnsavedWork()).toBe(false);

  let release: () => void = () => undefined;
  await act(async () => {
    release = retainActiveUpload();
  });
  expect(hasUnsavedWork()).toBe(true);

  await act(async () => {
    release();
  });
  expect(hasUnsavedWork()).toBe(false);
});
