import {
  expect,
  type Locator,
  type Page,
  test as base,
} from "@playwright/test";
import { panic } from "better-result";
import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import { createUploadedDocumentRoute } from "../helpers/document";
import {
  createTestWorkspace,
  deleteTestWorkspace,
  type TestWorkspace,
} from "../helpers/workspace";
import { JOURNEY_TAG } from "../playwright.journeys.config";

const FIXTURE_FILE_NAME = "journey-inspector.docx";
const FIXTURE_TEXT = "Stella E2E test document.";
const LONG_TASK_BUDGET_MS = 2000;
const FRAME_BUDGET_MS = 1000;
const FRAME_SAMPLES = 5;
const FRAME_SAMPLE_INTERVAL_MS = 500;
const LONG_TASKS_GLOBAL = "__stellaJourneyLongTasks";

const longTaskDurationsSchema = v.array(v.number());

const DOCK_STATE = {
  collapsed: "collapsed",
  expanded: "expanded",
} as const;

const recordLongTasks = async (page: Page) => {
  await page.addInitScript({
    content: `(() => {
      const durations = [];
      window.${LONG_TASKS_GLOBAL} = durations;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) durations.push(entry.duration);
      }).observe({ type: "longtask", buffered: true });
    })();`,
  });
};

const longestTask = async (page: Page): Promise<number> => {
  const durations = v.parse(
    longTaskDurationsSchema,
    await page.evaluate(`window.${LONG_TASKS_GLOBAL} ?? []`),
  );
  return Math.max(0, ...durations);
};

const frameRoundTrip = async (page: Page): Promise<number> => {
  const started = performance.now();
  const outcome = await Promise.race([
    page
      .evaluate(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
      )
      .then(() => "painted" as const),
    delay(FRAME_BUDGET_MS * 5).then(() => "frozen" as const),
  ]);
  expect(outcome, "the main thread paints a frame").toBe("painted");
  return performance.now() - started;
};

const expectInteractive = async (page: Page) => {
  for (let sample = 0; sample < FRAME_SAMPLES; sample += 1) {
    expect(await frameRoundTrip(page)).toBeLessThan(FRAME_BUDGET_MS);
    await delay(FRAME_SAMPLE_INTERVAL_MS);
  }
  expect(await longestTask(page)).toBeLessThan(LONG_TASK_BUDGET_MS);
};

const paneToggle = (dock: Locator, name: string) =>
  dock.getByRole("button", { exact: true, name });

const resizeHandle = (dock: Locator) =>
  dock.getByRole("separator", { name: messages.inspector.resizePane });

// Opening a document re-raises the key-required dialog wherever the target
// has no AI provider, and a modal dialog takes the dock out of the
// accessibility tree. `getAttribute` never runs the page's locator handlers;
// these auto-waiting assertions do, so the dialog is dismissed before the
// read, and anything else hiding the handle fails a named assertion.
const paneWidth = async (dock: Locator): Promise<number> => {
  await expect(dock).toHaveAttribute("data-state", DOCK_STATE.expanded);
  const handle = resizeHandle(dock);
  await expect(
    handle,
    "the expanded dock exposes its resize handle",
  ).toBeVisible();
  return Number(await handle.getAttribute("aria-valuenow"));
};

const expectDocumentOpen = async (page: Page, dock: Locator) => {
  await expect(dock).toHaveAttribute("data-state", DOCK_STATE.expanded);
  await expect(
    page.locator(".layout-run-text", { hasText: FIXTURE_TEXT }),
  ).toBeVisible({ timeout: 60_000 });
};

const reloadAndRestore = async (page: Page, dock: Locator) => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(dock).toBeVisible({ timeout: 60_000 });
  await expectInteractive(page);
  if ((await dock.getAttribute("data-state")) === DOCK_STATE.collapsed) {
    await paneToggle(dock, messages.inspector.showPane).click();
  }
  await expectDocumentOpen(page, dock);
  await expectInteractive(page);
};

const test = base.extend<{ workspace: TestWorkspace }>({
  workspace: async ({ page, request }, runFixture, testInfo) => {
    const workspace = await createTestWorkspace(request, "journey");
    await runFixture(workspace);
    await deleteTestWorkspace(request, workspace.id, {
      leave: { page, testInfo },
    });
  },
});

test.describe("inspector layout journey", () => {
  test(
    "a resized, minimized and restored inspector stays interactive across reloads",
    { tag: [JOURNEY_TAG.deployed, JOURNEY_TAG.localStack] },
    async ({ page, request, workspace }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
      });
      await page.addLocatorHandler(
        page.getByRole("dialog").filter({
          has: page.getByRole("heading", {
            name: messages.ai.keyRequired.title,
          }),
        }),
        async () => {
          await page.keyboard.press("Escape");
        },
      );
      await recordLongTasks(page);

      await createUploadedDocumentRoute({
        fileName: FIXTURE_FILE_NAME,
        request,
        workspace,
      });

      await page.goto(`/workspaces/${workspace.id}/${workspace.viewId}`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .getByRole("tab", { name: messages.workspaces.views.layouts.table })
        .click();
      await page
        .locator('[data-slot="workspace-grid-cell"]')
        .getByRole("button", { exact: true, name: FIXTURE_FILE_NAME })
        .click();
      const dock = page.locator('[data-slot="inspector-dock"]');
      await expectDocumentOpen(page, dock);

      const handle = resizeHandle(dock);
      const openedWidth = await paneWidth(dock);
      await handle.focus();
      await handle.press("PageUp");
      await handle.press("PageUp");
      await expect
        .poll(async () => await paneWidth(dock))
        .toBeGreaterThan(openedWidth);
      await handle.press("Home");
      await expect
        .poll(async () => await paneWidth(dock))
        .toBe(Number(await handle.getAttribute("aria-valuemin")));
      const narrowWidth = await paneWidth(dock);
      const box = await handle.boundingBox();
      if (box === null) {
        panic("The resize handle has no layout box");
      }
      const handleY = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width / 2, handleY);
      await page.mouse.down();
      await page.mouse.move(box.x - 200, handleY, { steps: 10 });
      await page.mouse.up();
      await expect
        .poll(async () => await paneWidth(dock))
        .toBeGreaterThan(narrowWidth);
      const resizedWidth = await paneWidth(dock);
      await expectInteractive(page);

      await paneToggle(dock, messages.inspector.hidePane).click();
      await expect(dock).toHaveAttribute("data-state", DOCK_STATE.collapsed);
      await expectInteractive(page);
      await paneToggle(dock, messages.inspector.showPane).click();
      await expectDocumentOpen(page, dock);
      expect(await paneWidth(dock)).toBe(resizedWidth);

      await reloadAndRestore(page, dock);
      expect(await paneWidth(dock)).toBe(resizedWidth);
      await reloadAndRestore(page, dock);
      expect(await paneWidth(dock)).toBe(resizedWidth);

      expect(pageErrors).toEqual([]);
    },
  );
});
