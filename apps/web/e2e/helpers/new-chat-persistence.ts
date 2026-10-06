import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { panic } from "better-result";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import type { WebApiRoutes } from "../../src/lib/eden-client";
import { apiGet } from "./api";
import { dockedChatMessagePage } from "./docked-chat-history";

export const PERSISTENCE_THREAD_ID = "019a0000-0000-7000-8000-000000000001";
export const PERSISTENCE_MODEL = "openai::synthetic-model";

type PersistenceHistoryOptions = {
  onFreshRead?: () => Promise<void>;
  historyPath?: string;
};

export const installPersistenceHistory = async (
  page: Page,
  options: PersistenceHistoryOptions = {},
) => {
  const navigationData = await apiGet<
    WebApiRoutes["workspaces"]["navigation"]["get"]["response"][200]
  >(page.request, "/workspaces/navigation?statusScope=active");
  const matter = navigationData.workspaces.at(0);
  if (matter === undefined) {
    return panic("The seeded browser fixture must contain a matter");
  }
  const modelResponse = {
    model: PERSISTENCE_MODEL,
    reasoningEffort: null,
  } satisfies WebApiRoutes["chat"]["threads"][":threadId"]["model"]["patch"]["response"][200];
  await page.route(
    "**/v1/chat/threads/*/model*",
    async (route) => await route.fulfill({ json: modelResponse }),
  );
  let initialId =
    options.historyPath === undefined ? PERSISTENCE_THREAD_ID : undefined;
  await page.route("**/v1/chat/threads/*/messages*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    if (new URL(page.url()).pathname === options.historyPath) {
      initialId ??= id;
    }
    if (id !== initialId) {
      await options.onFreshRead?.();
    }
    await route.fulfill({
      json: {
        ...dockedChatMessagePage,
        contextMatterIds: [matter.id],
        model: PERSISTENCE_MODEL,
        messages: id === initialId ? dockedChatMessagePage.messages : [],
        threadExists: id === initialId,
      },
    });
  });
  await page.route(
    "**/v1/chat/threads/*/suggested-prompts*",
    async (route) => await route.fulfill({ json: { prompts: [] } }),
  );
  await page.route(
    "**/v1/chat/threads/*/title*",
    async (route) =>
      await route.fulfill({ json: { title: "Synthetic conversation" } }),
  );
  return { id: matter.id, name: matter.name };
};

export const rememberComposer = async (page: Page) => {
  const editor = page.locator('[contenteditable="true"]:visible').first();
  const dock = page.locator('[data-slot="chat-composer-dock"]:visible').first();
  await expect(editor).toBeVisible();
  await expect(dock).toHaveAttribute("data-status", "ready");
  const editorNode = await editor.elementHandle();
  const dockNode = await dock.elementHandle();
  const matter = dock.locator('[data-slot="menu-trigger"]').first();
  const matterNode = await matter.elementHandle();
  const model = page.getByRole("button", {
    name: PERSISTENCE_MODEL,
    exact: true,
  });
  const modelNode = await model.elementHandle();
  const dockBox = await dock.boundingBox();
  const beforeBox = await editor.boundingBox();
  if (beforeBox === null || dockBox === null) {
    return panic("The ready composer must have its input and controls mounted");
  }
  return {
    editor,
    dock,
    model,
    editorNode,
    dockNode,
    modelNode,
    matter,
    matterNode,
    beforeBox,
    dockBox,
  };
};

export const expectComposerPreserved = async ({
  editor,
  dock,
  editorNode,
  dockNode,
  model,
  modelNode,
  matter,
  matterNode,
  dockBox,
  beforeBox,
}: Awaited<ReturnType<typeof rememberComposer>>) => {
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((node, previous) => node === previous, editorNode),
  ).toBe(true);
  expect(
    await dock.evaluate((node, previous) => node === previous, dockNode),
  ).toBe(true);
  expect(
    await model.evaluate((node, previous) => node === previous, modelNode),
  ).toBe(true);
  expect(
    await matter.evaluate((node, previous) => node === previous, matterNode),
  ).toBe(true);
  await expect.poll(async () => await editor.boundingBox()).toEqual(beforeBox);
  await expect.poll(async () => await dock.boundingBox()).toEqual(dockBox);
};

export const expectComposerScope = async (page: Page, matterName: string) => {
  const dock = page.locator('[data-slot="chat-composer-dock"]:visible').first();
  await expect(dock.getByTitle(matterName, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: PERSISTENCE_MODEL, exact: true }),
  ).toBeVisible();
};

export const resetFromCompactAnswer = async (page: Page, card: Locator) => {
  await expect(card).toContainText("Saved geometry test answer.");
  await card
    .getByRole("button", { name: messages.chat.newChat, exact: true })
    .click();
  await expect(
    page.getByText("Saved geometry test answer.", { exact: true }),
  ).toHaveCount(0);
};

export const expectComposerVisibleWhilePending = async (
  composer: Awaited<ReturnType<typeof rememberComposer>>,
) => {
  expect(await composer.editorNode.evaluate((node) => node.isConnected)).toBe(
    true,
  );
  expect(await composer.dockNode.evaluate((node) => node.isConnected)).toBe(
    true,
  );
  await expect(composer.editor).toBeVisible();
  await expect(composer.dock).toBeVisible();
  expect(await composer.editor.boundingBox()).toEqual(composer.beforeBox);
  expect(await composer.dock.boundingBox()).toEqual(composer.dockBox);
};

export const delayFreshThreadRead = () => {
  const requested = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const onFreshRead = async () => {
    requested.resolve(undefined);
    await Promise.all([
      released.promise,
      new Promise((resolve) => {
        setTimeout(resolve, 1200);
      }),
    ]);
  };
  return {
    waitForPendingBoundary: async () =>
      await new Promise((resolve) => {
        setTimeout(resolve, 1400);
      }),
    requested: requested.promise,
    release: () => released.resolve(undefined),
    onFreshRead,
  };
};
