import type { Locator, Page } from "@playwright/test";

import { DECISION_AI_MODE } from "../../src/features/case-law/components/case-viewer/decision-ai-mode";
import { expect } from "./test";

/** The public page a decision spec boots the app on before navigating. */
export const DECISION_READER_BOOT_PATH = "/law";

type OpenDecisionOptions = {
  /** Same-origin page the app boots on; the router must mount there. */
  bootPath: string;
  /** The decision route, with any fragment the spec lands on. */
  path: string;
};

/**
 * Navigates the booted app on the client, for a route that is not a decision
 * reader; a decision opens through `openMemberDecision` or
 * `openVisitorDecision`. The router wraps pushState once it mounts; a push
 * before that is a bare URL change, so this waits for the wrapper first.
 */
export const pushRouterPath = async (page: Page, path: string) => {
  // A cold dev server hydrates slowly; this allows for the first compile.
  await page.waitForFunction(
    () => !history.pushState.toString().includes("[native code]"),
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate((target) => {
    history.pushState(null, "", target);
  }, path);
};

// A direct load renders the decision on the server, where page.route cannot
// answer the decision read; boot the app on another page and navigate on the
// client so the read comes from the browser.
const navigateInApp = async (
  page: Page,
  { bootPath, path }: OpenDecisionOptions,
) => {
  await page.goto(bootPath, { waitUntil: "domcontentloaded" });
  await pushRouterPath(page, path);
};

/**
 * Waits for a signed-in user's decision reader to offer their AI and returns
 * it. The reader mounts gated and stays mounted; the lazy member chunk turns
 * the same reader's AI on once it arrives, which is what this waits for.
 */
export const expectMemberDecisionReader = async (
  page: Page,
): Promise<Locator> => {
  const reader = page.locator(`[data-ai-mode="${DECISION_AI_MODE.enabled}"]`, {
    has: page.locator('[data-slot="reader-document-column"]'),
  });
  await expect(reader).toBeVisible({ timeout: 30_000 });
  return reader;
};

/** Opens a decision as the signed-in user and returns the reader that stays. */
export const openMemberDecision = async (
  page: Page,
  options: OpenDecisionOptions,
): Promise<Locator> => {
  await navigateInApp(page, options);
  return await expectMemberDecisionReader(page);
};

/**
 * Opens a decision as a visitor. A visitor's reader mounts once, with no
 * fallback to replace, so the spec waits for whatever it tests.
 */
export const openVisitorDecision = async (
  page: Page,
  options: OpenDecisionOptions,
) => {
  await navigateInApp(page, options);
};
