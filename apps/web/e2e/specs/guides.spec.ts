import type { Page } from "@playwright/test";

import { getStorageKey } from "../../src/consts";
import { GUIDE_ANCHORS } from "../../src/features/guides/guide-anchors";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const HELP_BUTTON_NAME = "Help and guides";
const GUIDE_POPOVER_SELECTOR = ".stella-guide-popover";
const GUIDE_NEXT_BUTTON_SELECTOR = ".driver-popover-next-btn";
const GUIDE_PREVIOUS_BUTTON_SELECTOR = ".driver-popover-prev-btn";
const GUIDE_TEST_TIMEOUT_MS = 90_000;
const GUIDE_NAVIGATION_TIMEOUT_MS = 45_000;

test.beforeEach((_fixtures, testInfo) => {
  // A cold dev server compiles the lazy guide engine plus whichever product
  // surface the tour enters. Production E2E uses prebuilt chunks, but local
  // runs need enough headroom to validate the same browser state machine.
  testInfo.setTimeout(GUIDE_TEST_TIMEOUT_MS);
});

const enableGuidesTestFeatures = async (page: Page) => {
  await page.addInitScript(
    ({ devStorageKey, i18nStorageKey }) => {
      localStorage.setItem(
        devStorageKey,
        JSON.stringify({
          state: { playbooksPreview: true, workflowsPreview: true },
          version: 0,
        }),
      );
      localStorage.setItem(
        i18nStorageKey,
        JSON.stringify({ state: { lang: "en" }, version: 0 }),
      );
    },
    {
      devStorageKey: getStorageKey("dev"),
      i18nStorageKey: getStorageKey("i18n"),
    },
  );
};

const guidePopover = (page: Page) => page.locator(GUIDE_POPOVER_SELECTOR);

const expectGuideStep = async (
  page: Page,
  anchor: string,
  progress: `${number} of ${number}`,
) => {
  const target = page.locator(`[data-guide-anchor="${anchor}"]`);
  await expect(target).toHaveCount(1);
  await expect(guidePopover(page)).toBeVisible();
  await expect(
    guidePopover(page).locator(".driver-popover-progress-text"),
  ).toHaveText(progress);
};

const advanceToGuideStep = async (
  page: Page,
  anchor: string,
  progress: `${number} of ${number}`,
) => {
  await guidePopover(page).locator(GUIDE_NEXT_BUTTON_SELECTOR).click();
  await expectGuideStep(page, anchor, progress);
};

const finishGuide = async (page: Page) => {
  await guidePopover(page).locator(GUIDE_NEXT_BUTTON_SELECTOR).click();
  await expect(guidePopover(page)).toHaveCount(0);
};

const startGuide = async (page: Page, title: string) => {
  const helpButton = page.getByRole("button", { name: HELP_BUTTON_NAME });
  await expect(helpButton).toBeVisible({ timeout: 30_000 });
  await helpButton.click();
  const drawer = page.getByRole("dialog", { name: HELP_BUTTON_NAME });
  const card = drawer.locator("li").filter({ hasText: title });
  const start = card.getByRole("button", { name: /^(?:Replay|Start)$/u });
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await start.click();
  await expect(drawer).toHaveCount(0);
};

test("Chat guide resolves every live anchor exactly once", async ({ page }) => {
  await enableGuidesTestFeatures(page);
  await page.goto("/chat", {
    timeout: GUIDE_NAVIGATION_TIMEOUT_MS,
    waitUntil: "commit",
  });

  await startGuide(page, "Ask with the right context");
  await expectGuideStep(page, GUIDE_ANCHORS.chatComposer, "1 of 9");
  await advanceToGuideStep(page, GUIDE_ANCHORS.chatToolsButton, "2 of 9");
  await advanceToGuideStep(page, GUIDE_ANCHORS.chatMenuAttach, "3 of 9");
  await advanceToGuideStep(page, GUIDE_ANCHORS.chatMenuModels, "4 of 9");
  await advanceToGuideStep(page, GUIDE_ANCHORS.chatMenuSkills, "5 of 9");
  await advanceToGuideStep(page, GUIDE_ANCHORS.chatMenuContext, "6 of 9");
  await advanceToGuideStep(page, GUIDE_ANCHORS.chatMenuMcp, "7 of 9");
  await advanceToGuideStep(page, GUIDE_ANCHORS.chatAnonymize, "8 of 9");
  await advanceToGuideStep(page, GUIDE_ANCHORS.chatSend, "9 of 9");
  await finishGuide(page);
});

test("Guide checklist stays stable until matter availability resolves", async ({
  page,
  request,
}) => {
  let workspace: TestWorkspace | null = null;
  try {
    workspace = await createTestWorkspace(request, "guides-loading");
    await enableGuidesTestFeatures(page);

    // The first drawer open waits for its permission-and-limit policy instead
    // of rendering a partial checklist whose cards and denominator then jump.
    await page.route(
      /\/v1\/(?:workspaces|entities|properties)\//u,
      async (route) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 750);
        });
        await route.continue();
      },
    );
    await page.goto("/chat", {
      timeout: GUIDE_NAVIGATION_TIMEOUT_MS,
      waitUntil: "commit",
    });
    const helpButton = page.getByRole("button", { name: HELP_BUTTON_NAME });
    await expect(helpButton).toBeVisible({ timeout: 30_000 });
    await helpButton.click();
    const drawer = page.getByRole("dialog", { name: HELP_BUTTON_NAME });
    await expect(drawer.locator('[aria-busy="true"]')).toBeVisible();
    await expect(
      drawer.locator("li").filter({ hasText: "Work with documents" }),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    if (workspace) {
      await deleteTestWorkspace(request, workspace.id);
    }
  }
});

test("Documents guide spotlights one actionable upload target", async ({
  page,
  request,
}) => {
  let workspace: TestWorkspace | null = null;
  try {
    workspace = await createTestWorkspace(request, "guides-documents");
    await enableGuidesTestFeatures(page);
    await page.goto(`/workspaces/${workspace.id}/${workspace.viewId}`, {
      timeout: GUIDE_NAVIGATION_TIMEOUT_MS,
      waitUntil: "commit",
    });

    await startGuide(page, "Work with documents");
    await expectGuideStep(page, GUIDE_ANCHORS.documentsUpload, "1 of 2");
    await expect(
      page.locator(`[data-guide-anchor="${GUIDE_ANCHORS.documentsUpload}"]`),
    ).toHaveRole("button");
    await advanceToGuideStep(page, GUIDE_ANCHORS.documentsList, "2 of 2");
    await finishGuide(page);
  } finally {
    if (workspace) {
      await deleteTestWorkspace(request, workspace.id);
    }
  }
});

test("Tabular guide closes the column composer after its final step", async ({
  page,
}) => {
  await enableGuidesTestFeatures(page);
  await page.goto("/chat", {
    timeout: GUIDE_NAVIGATION_TIMEOUT_MS,
    waitUntil: "commit",
  });

  // Start outside a matter to exercise the guide's dynamic table-route
  // resolver against the seeded user's first authorized matter.
  await startGuide(page, "Review in a table");
  await expectGuideStep(page, GUIDE_ANCHORS.tabularReviewTable, "1 of 3");
  await advanceToGuideStep(
    page,
    GUIDE_ANCHORS.tabularReviewAddColumn,
    "2 of 3",
  );
  await advanceToGuideStep(
    page,
    GUIDE_ANCHORS.tabularReviewAnswerType,
    "3 of 3",
  );
  await finishGuide(page);
  await expect(
    page.locator(
      `[data-guide-anchor="${GUIDE_ANCHORS.tabularReviewAnswerType}"]`,
    ),
  ).toHaveCount(0);
});

test("Playbooks guide reverses and replays its local editor transition", async ({
  page,
}) => {
  await enableGuidesTestFeatures(page);
  await page.goto("/chat", {
    timeout: GUIDE_NAVIGATION_TIMEOUT_MS,
    waitUntil: "commit",
  });

  await startGuide(page, "Build a playbook");
  await expectGuideStep(page, GUIDE_ANCHORS.playbooksOverview, "1 of 4");
  await advanceToGuideStep(page, GUIDE_ANCHORS.playbooksCreate, "2 of 4");
  await advanceToGuideStep(page, GUIDE_ANCHORS.playbooksBasics, "3 of 4");

  await guidePopover(page).locator(GUIDE_PREVIOUS_BUTTON_SELECTOR).click();
  await expectGuideStep(page, GUIDE_ANCHORS.playbooksCreate, "2 of 4");
  await advanceToGuideStep(page, GUIDE_ANCHORS.playbooksBasics, "3 of 4");
  await advanceToGuideStep(page, GUIDE_ANCHORS.playbooksAddPosition, "4 of 4");
  await finishGuide(page);

  // Finishing leaves the reversible local editor visible. Replaying from that
  // pathname starts at its first visible editor step without discarding work;
  // Back then follows the real reversible transition to the beginning.
  await startGuide(page, "Build a playbook");
  await expectGuideStep(page, GUIDE_ANCHORS.playbooksBasics, "3 of 4");
  await guidePopover(page).locator(GUIDE_PREVIOUS_BUTTON_SELECTOR).click();
  await expectGuideStep(page, GUIDE_ANCHORS.playbooksCreate, "2 of 4");
  await guidePopover(page).locator(GUIDE_PREVIOUS_BUTTON_SELECTOR).click();
  await expectGuideStep(page, GUIDE_ANCHORS.playbooksOverview, "1 of 4");
});

test("Workflows guide reaches trigger, chained steps, and review gate", async ({
  page,
}) => {
  await enableGuidesTestFeatures(page);
  await page.goto("/chat", {
    timeout: GUIDE_NAVIGATION_TIMEOUT_MS,
    waitUntil: "commit",
  });

  await startGuide(page, "Automate a workflow");
  await expectGuideStep(page, GUIDE_ANCHORS.workflowsOverview, "1 of 5");
  await advanceToGuideStep(page, GUIDE_ANCHORS.workflowsCreate, "2 of 5");
  await advanceToGuideStep(page, GUIDE_ANCHORS.workflowsTrigger, "3 of 5");
  await advanceToGuideStep(page, GUIDE_ANCHORS.workflowsSteps, "4 of 5");
  await advanceToGuideStep(page, GUIDE_ANCHORS.workflowsReviewGate, "5 of 5");
  await finishGuide(page);
});
