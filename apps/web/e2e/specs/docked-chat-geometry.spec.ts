import type { Page } from "@playwright/test";
import path from "node:path";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import {
  createDockedChatWorld,
  deleteDockedChatWorld,
  installDockedChatHistory,
  restoreGeometryInspector,
} from "../helpers/docked-chat-fixtures";
import type { DockedChatWorld } from "../helpers/docked-chat-fixtures";
import { readDockedChatHosts } from "../helpers/docked-chat-hosts";
import type { DockedChatHost } from "../helpers/docked-chat-hosts";
import {
  installDockedLegalFixtures,
  dockedLegalPath,
} from "../helpers/docked-chat-legal-fixtures";
import { installDockedChatPageFixtures } from "../helpers/docked-chat-page-fixtures";
import { expect, test as base } from "../helpers/test";

const { hosts, providerSources } = readDockedChatHosts();
const viewports = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];
const test = base.extend<Record<never, never>, { world: DockedChatWorld }>({
  world: [
    async ({ playwright }, runFixture) => {
      const request = await playwright.request.newContext({
        storageState: path.resolve(
          import.meta.dirname,
          "../../../../.playwright/storage-state.json",
        ),
      });
      const world = await createDockedChatWorld(request);
      try {
        await runFixture(world);
      } finally {
        await deleteDockedChatWorld(request, world);
        await request.dispose();
      }
    },
    { scope: "worker" },
  ],
});

const routePath = (host: DockedChatHost, world: DockedChatWorld): string => {
  if (host.template.startsWith("/law/")) {
    return dockedLegalPath(host.template);
  }
  if (host.template === "/knowledge/templates") {
    return `/knowledge/templates?template=${world.templateId}`;
  }
  if (host.template.endsWith("/$viewId/document")) {
    return world.document.path;
  }
  const values: Record<string, string> = {
    workspaceId: world.workspace.id,
    viewId: world.workspace.viewId,
    contactId: world.contactId,
    threadId: "019a0000-0000-7000-8000-000000000001",
    code: "abcdmnp239",
    registry: "companies-house",
    companyId: "12345678",
    correspondenceId: world.document.entityId,
    invoiceId: world.document.entityId,
    exportId: world.document.entityId,
    packId: "general-legal",
    templateId: "mutual-nda",
    entry: "contract-review-anthropic",
  };
  return host.template.replaceAll(/\$([A-Za-z]+)/gu, (_, parameter: string) => {
    const value = values[parameter];
    if (value === undefined) {
      throw new Error(
        `Add a dock geometry fixture for route parameter ${parameter} (${host.template})`,
      );
    }
    return value;
  });
};

/** Compare the painted card with its own registered composer column, never
 * a second reader's bar or an unrelated main chat composer. */
const expectDockGeometry = async (page: Page) => {
  const thread = page
    .locator('[data-slot="docked-chat-thread"]:visible')
    .filter({
      has: page.getByRole("dialog", { name: messages.chat.aiThread }),
    });
  await expect(thread).toHaveCount(1, { timeout: 45_000 });
  const card = thread.getByRole("dialog", { name: messages.chat.aiThread });
  await expect(card).toContainText("Saved geometry test answer.");
  await expect
    .poll(
      async () =>
        card.evaluate((element) => {
          const slot = element.closest('[data-slot="docked-chat-thread"]');
          const column = slot?.parentElement;
          const composer = column?.querySelector(
            '[data-slot="docked-chat-composer"]',
          );
          if (!(composer instanceof HTMLElement)) {
            throw new Error(
              "Thread card is missing its registered composer column",
            );
          }
          const cardRect = element.getBoundingClientRect();
          const composerRect = composer.getBoundingClientRect();
          return {
            inlineStartAligned:
              Math.abs(cardRect.left - composerRect.left) <= 1,
            inlineEndAligned:
              Math.abs(cardRect.right - composerRect.right) <= 1,
            aboveComposer: cardRect.bottom <= composerRect.top,
            directlyAboveComposer: composerRect.top - cardRect.bottom <= 9,
            cardInsideViewport:
              cardRect.left >= 0 &&
              cardRect.top >= 0 &&
              cardRect.right <= innerWidth &&
              cardRect.bottom <= innerHeight,
            composerInsideViewport:
              composerRect.left >= 0 &&
              composerRect.top >= 0 &&
              composerRect.right <= innerWidth &&
              composerRect.bottom <= innerHeight,
          };
        }),
      {
        message:
          "thread card aligns above its composer and stays in the viewport",
      },
    )
    .toEqual({
      inlineStartAligned: true,
      inlineEndAligned: true,
      aboveComposer: true,
      directlyAboveComposer: true,
      cardInsideViewport: true,
      composerInsideViewport: true,
    });
};

for (const viewport of viewports) {
  test.describe(`docked chat geometry ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });
    for (const host of hosts) {
      test(`${host.template} keeps the thread inside its composer column`, async ({
        page,
        world,
      }, testInfo) => {
        test.slow();
        const isMainReader = host.surfaces.some(
          (surface) => surface !== "inspector",
        );
        await installDockedChatHistory(page);
        await installDockedLegalFixtures(page);
        await installDockedChatPageFixtures(page, {
          workspaceId: world.workspace.id,
          resourceId: world.document.entityId,
        });
        await restoreGeometryInspector(page, {
          world,
          presentation:
            isMainReader && !host.template.startsWith("/law")
              ? "reader"
              : "inspector",
        });
        const destination = routePath(host, world);
        if (host.template.startsWith("/law")) {
          // Public-law shells share the live inspector store but do not
          // restore member persistence on a cold load. Carry the opened
          // document through the router's native browser-history adapter.
          // Legal HTTP fixtures also belong to client loader reads, not SSR.
          await page.goto("/chat", { waitUntil: "commit" });
          await expectDockGeometry(page);
          if (isMainReader) {
            await page
              .getByRole("button", { name: messages.common.close, exact: true })
              .click();
            await expect(
              page.getByText("Saved geometry test answer.", { exact: true }),
            ).not.toBeVisible();
          }
          await page.evaluate(
            (url) => history.pushState(null, "", url),
            destination,
          );
          await expect(
            page.locator('nav a[href="/law"]').first(),
          ).toBeAttached();
        } else {
          await page.goto(destination, { waitUntil: "commit" });
        }
        if (
          isMainReader &&
          viewport.width === 390 &&
          !host.template.startsWith("/law")
        ) {
          const inspector = page.getByRole("dialog", {
            name: messages.inspector.title,
            exact: true,
          });
          await expect(inspector).toBeVisible();
          await inspector
            .getByRole("button", { name: messages.common.close, exact: true })
            .click();
          await expect(inspector).not.toBeVisible();
        }
        // A hydrated saved answer opens the actual card without an AI request.
        await expectDockGeometry(page);
        testInfo.annotations.push({
          type: "provider census",
          description: providerSources.join(", "),
        });
      });
    }
  });
}
