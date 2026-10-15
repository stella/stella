import type { Page } from "@playwright/test";
import "@tanstack/react-router";

import { appShellNavigationLink } from "../helpers/app-shell";
import { expect, test } from "../helpers/test";

const cases = [
  { path: "/workspaces", listPath: "/v1/workspaces" },
  { path: "/contacts", listPath: "/v1/contacts" },
] as const;

const holdProtectedLoader = async (page: Page, path: string) => {
  await page.evaluate((targetPath) => {
    const router = window.__TSR_ROUTER__;
    const route = router?.routesById["/_protected"];
    const original = route?.options.loader;
    if (route === undefined || typeof original !== "function") {
      throw new Error("The production protected route loader must exist");
    }
    const child = router?.routesById[`/_protected${targetPath}/`];
    const originalChild = child?.options.loader;
    if (child === undefined || typeof originalChild !== "function") {
      throw new Error("The production page route loader must exist");
    }
    const gate = Promise.withResolvers<undefined>();
    window.addEventListener(
      "release-protected-loader",
      () => gate.resolve(undefined),
      {
        once: true,
      },
    );
    window.addEventListener(
      "restore-protected-loader",
      () => {
        gate.resolve(undefined);
        route.update({ loader: original });
        child.update({ loader: originalChild });
        delete document.documentElement.dataset["parentLoaderHeld"];
        delete document.documentElement.dataset["parentLoaderSettled"];
        delete document.documentElement.dataset["pageLoaderState"];
      },
      { once: true },
    );
    route.update({
      loader: async (context: Parameters<typeof original>[0]) => {
        const result = await original(context);
        document.documentElement.dataset["parentLoaderHeld"] = "true";
        await gate.promise;
        document.documentElement.dataset["parentLoaderSettled"] = "true";
        return result;
      },
    });
    child.update({
      loader: async (context: Parameters<typeof originalChild>[0]) => {
        document.documentElement.dataset["pageLoaderState"] = "running";
        const result = await originalChild(context);
        document.documentElement.dataset["pageLoaderState"] = "settled";
        return result;
      },
    });
  }, path);
};

const holdRequest = async (page: Page, path: string) => {
  const gate = Promise.withResolvers<undefined>();
  let requested = false;
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      requested = true;
      await gate.promise;
      await route.continue();
    },
  );
  return { requested: () => requested, release: () => gate.resolve(undefined) };
};

const expectSingleShell = async (page: Page) => {
  // The old static shell has no sidebar slot; include its visible sidebar
  // column so it cannot hide from the same census as the mounted app chrome.
  expect(
    await page
      .locator('[data-slot="sidebar"]:visible, .bg-sidebar.w-64:visible')
      .count(),
  ).toBe(1);
  // Exclude hidden wordmarks without hiding a second rendered logo.
  expect(await page.locator('svg[viewBox="0 0 573 151"]:visible').count()).toBe(
    1,
  );
};

for (const { path, listPath } of cases) {
  test(`${path} keeps one app shell throughout delayed parent and page loaders`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("sidebar_state", "expanded");
    });
    await page.goto("/knowledge", { waitUntil: "commit" });
    await expect(appShellNavigationLink(page, path)).toBeVisible({
      timeout: 30_000,
    });
    await expectSingleShell(page);
    const list = await holdRequest(page, listPath);
    const content = page.locator('[data-slot="workspace-shell-content"]');
    await holdProtectedLoader(page, path);

    try {
      // Navigate through the mounted app, using its real route tree and frame.
      await appShellNavigationLink(page, path).click();
      await expect(page.locator("html")).toHaveAttribute(
        "data-parent-loader-held",
        "true",
      );
      await expect.poll(list.requested).toBe(true);
      await expect(page).toHaveURL(new RegExp(`${path}/?(?:\\?.*)?$`, "u"));
      await expect(
        content.locator('[data-slot="skeleton"]').first(),
      ).toBeVisible();
      await expectSingleShell(page);

      await page.evaluate(() =>
        window.dispatchEvent(new Event("release-protected-loader")),
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-parent-loader-settled",
        "true",
        { timeout: 2000 },
      );
      // The router can retain the parent fallback until its child settles.
      // Prove the actual page loader remains in flight instead of requiring
      // a particular route-specific toolbar to have replaced that fallback.
      await expect(page.locator("html")).toHaveAttribute(
        "data-page-loader-state",
        "running",
        { timeout: 2000 },
      );
      await expect(
        content.locator('[data-slot="skeleton"]').first(),
      ).toBeVisible({ timeout: 2000 });
      await expectSingleShell(page);

      const listResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === listPath,
      );
      list.release();
      expect((await listResponse).ok()).toBe(true);
      await expect(page.locator("html")).toHaveAttribute(
        "data-page-loader-state",
        "settled",
      );
      await expect(
        content.locator("input[placeholder]:enabled").first(),
      ).toBeVisible();
      await expect(content.locator("input[placeholder]:disabled")).toHaveCount(
        0,
      );
      await expect(page).toHaveURL(new RegExp(`${path}/?(?:\\?.*)?$`, "u"));
      await expectSingleShell(page);
    } finally {
      list.release();
      await page.evaluate(() =>
        window.dispatchEvent(new Event("restore-protected-loader")),
      );
    }
  });
}
