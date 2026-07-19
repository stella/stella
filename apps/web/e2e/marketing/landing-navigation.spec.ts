import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Class guard: landing islands must survive ClientRouter (view transition)
// navigation round-trips. Astro swaps the whole document on soft navigation,
// which re-runs island hydration, IntersectionObserver-gated loops, and the
// head swap that carries the stylesheets the islands' layout depends on. A
// regression anywhere in that path shows up as the opening product scene
// failing to re-reach the same healthy interactive state it had on the
// initial load, so the spec asserts that state twice: fresh load, and again
// after navigating to a product page and going back.

const SOFT_NAV_MARKER = "__landingSoftNavProbe";

type OpeningSceneHealth = {
  present: boolean;
  // The Teams window sits inset inside the scene (start/top offsets applied),
  // not collapsed onto the scene origin.
  teamsInsideScene: boolean;
  // The Teams window occupies its designed fraction of the scene, not an
  // unconstrained auto width.
  teamsProportional: boolean;
  // The auto-playing Teams loop reaches the answer step: the playbook
  // deviation card fades in (its reveal is opacity-driven, so visibility
  // checks alone cannot see it).
  deviationCardShown: boolean;
};

const HEALTHY: OpeningSceneHealth = {
  present: true,
  teamsInsideScene: true,
  teamsProportional: true,
  deviationCardShown: true,
};

const readOpeningSceneHealth = (): OpeningSceneHealth => {
  const scene = document.querySelector("#opening-product-story .cli-story");
  const teams = document.querySelector("#opening-product-story .cli-client");
  const card = teams?.querySelector(".story-step .story-step") ?? null;
  if (!scene || !teams || !card) {
    return {
      present: false,
      teamsInsideScene: false,
      teamsProportional: false,
      deviationCardShown: false,
    };
  }
  const sceneRect = scene.getBoundingClientRect();
  const teamsRect = teams.getBoundingClientRect();
  return {
    present: true,
    teamsInsideScene:
      teamsRect.left > sceneRect.left + 1 && teamsRect.top > sceneRect.top + 1,
    teamsProportional:
      teamsRect.width > 0 && teamsRect.width < sceneRect.width * 0.35,
    deviationCardShown: getComputedStyle(card).opacity === "1",
  };
};

const expectHealthyOpeningScene = async (page: Page) => {
  const story = page.locator("#opening-product-story");
  await expect(story.locator(".cli-story")).toBeVisible();
  await expect(story.locator(".cli-main-window")).toBeVisible();
  await expect(story.locator(".cli-client")).toBeVisible();
  await expect(story.locator(".cli-response")).toBeVisible();
  await expect(story.locator(".cli-window")).toBeVisible();

  await expect
    .poll(() => page.evaluate(readOpeningSceneHealth), {
      message: "opening scene reaches its healthy interactive state",
      timeout: 20_000,
    })
    .toEqual(HEALTHY);
};

test("opening scene stays healthy after a navigation round-trip", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expectHealthyOpeningScene(page);

  // Tag the current document so the round-trip provably stays on the
  // client-side router: a full page reload would reset the flag and bypass
  // the swap path this spec guards.
  await page.evaluate((marker) => {
    Reflect.set(window, marker, true);
  }, SOFT_NAV_MARKER);

  // Navigate via the header product menu so the scroll position stays at the
  // top and the scene is in the viewport again right after going back.
  await page.locator("summary.nav-link").first().click();
  await page.locator('.nav-mega a[href="/product/workspace"]').first().click();
  await page.waitForURL("**/product/workspace");
  await expect(page.locator("main").first()).toBeVisible();

  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/");
  expect(
    await page.evaluate(
      (marker) => Reflect.get(window, marker) === true,
      SOFT_NAV_MARKER,
    ),
    "round-trip must stay on the client-side router (no full reload)",
  ).toBe(true);

  await expectHealthyOpeningScene(page);
});
