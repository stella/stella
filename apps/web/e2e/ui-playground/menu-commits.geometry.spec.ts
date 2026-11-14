/**
 * How many React commits a menu takes to open and to close.
 *
 * The bench at `/dev?visual=menu-commits` holds one menu per cause: the
 * primitive alone, the shared menu, a tooltip on its trigger, radio rows and
 * a long list. The dev-only render-storm canary counts every commit of the
 * app (`RENDER_COMMIT_COUNT_GLOBAL`); a menu's commits are measured between
 * the states a reader sees, the trigger pressed and the menu shown or gone.
 * Motion is left on, as a reader has it: a transition's phases are commits.
 */

import { expect, type Page, test } from "@playwright/test";

import { RENDER_COMMIT_COUNT_GLOBAL } from "../../src/lib/render-storm-canary";
import { menuCommitBenches } from "../../src/routes/dev/-visual-metadata";

// A page without the counter (a production build, or the canary no longer
// around the app) measures nothing, and every budget would pass on zero.
const readCommits = async (page: Page) =>
  await page.evaluate((key) => {
    const counted: unknown = Reflect.get(globalThis, key);
    if (typeof counted !== "number") {
      throw new TypeError(`The page counts no commits (${key} is unset).`);
    }
    return counted;
  }, RENDER_COMMIT_COUNT_GLOBAL);

type Bench = keyof typeof menuCommitBenches;
const BENCHES = Object.keys(menuCommitBenches).filter(
  (bench): bench is Bench => bench in menuCommitBenches,
);

/**
 * The most commits each menu may take to open and to close: the highest
 * count measured, plus one. The margin is one commit of run-to-run
 * variation (the tooltip menu opened by keyboard took 21 in some projects
 * and 22 in others); a real regression, a new store write or effect per
 * open or close, takes more than that. Each menu is measured on a newly
 * loaded page: one measured after another inherits its focus and its warm
 * tooltip, and commits differently. The primitive is the floor, which the
 * shared menu adds nothing to. Closing is always by Escape, which returns
 * focus to the trigger: there the tooltip opens, and that is the difference
 * between `tooltip` and `tooltip-quiet-on-focus`.
 */
const COMMIT_BUDGET = {
  pointer: {
    primitive: { open: 12, close: 7 },
    plain: { open: 12, close: 7 },
    tooltip: { open: 13, close: 16 },
    "tooltip-quiet-on-focus": { open: 13, close: 8 },
    radio: { open: 12, close: 7 },
    many: { open: 13, close: 7 },
  },
  keyboard: {
    primitive: { open: 11, close: 7 },
    plain: { open: 11, close: 7 },
    tooltip: { open: 23, close: 16 },
    "tooltip-quiet-on-focus": { open: 12, close: 7 },
    radio: { open: 11, close: 7 },
    many: { open: 11, close: 7 },
  },
} as const satisfies Record<
  "pointer" | "keyboard",
  Record<Bench, { open: number; close: number }>
>;

for (const how of ["pointer", "keyboard"] as const) {
  for (const bench of BENCHES) {
    const budget = COMMIT_BUDGET[how][bench];

    test(`the ${bench} menu opened by ${how} stays within its commits to open and to close`, async ({
      page,
    }) => {
      await page.goto("/dev?visual=menu-commits", {
        waitUntil: "domcontentloaded",
      });
      const trigger = page
        .locator(`[data-playground-section="menu-commits:${bench}"]`)
        .getByRole("button");
      await expect(trigger).toBeVisible();
      const menu = page.getByRole("menu");

      const atRest = await readCommits(page);
      if (how === "pointer") {
        await trigger.click();
      } else {
        await trigger.focus();
        await page.keyboard.press("Enter");
      }
      await expect(menu).toBeVisible();
      const opened = await readCommits(page);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      const measured = {
        bench,
        open: opened - atRest,
        close: (await readCommits(page)) - opened,
      };

      // The numbers go to the run's output as well as its report.
      process.stdout.write(
        `menu commits (${how}, ${test.info().project.name}): ${JSON.stringify(measured)}\n`,
      );
      // Opening and closing a menu both commit: zero is a broken counter.
      expect(measured.open, "to open").toBeGreaterThan(0);
      expect(measured.close, "to close").toBeGreaterThan(0);
      expect(measured.open, "to open").toBeLessThanOrEqual(budget.open);
      expect(measured.close, "to close").toBeLessThanOrEqual(budget.close);
    });
  }
}
