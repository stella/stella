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

const readCommits = async (page: Page) =>
  await page.evaluate((key) => {
    const counted: unknown = Reflect.get(globalThis, key);
    return typeof counted === "number" ? counted : 0;
  }, RENDER_COMMIT_COUNT_GLOBAL);

type Bench = keyof typeof menuCommitBenches;
const BENCHES = Object.keys(menuCommitBenches).filter(
  (bench): bench is Bench => bench in menuCommitBenches,
);

/**
 * The commits each menu takes today, the same in every project of the suite,
 * so they are the budget as they stand: a menu that commits more fails. The
 * primitive is the floor, which the shared menu adds nothing to. Closing is
 * always by Escape, which returns focus to the trigger.
 */
const COMMIT_BUDGET = {
  pointer: {
    primitive: { open: 11, close: 6 },
    plain: { open: 11, close: 6 },
    tooltip: { open: 12, close: 15 },
    "tooltip-quiet-on-focus": { open: 12, close: 15 },
    radio: { open: 14, close: 8 },
    many: { open: 12, close: 6 },
  },
  keyboard: {
    primitive: { open: 10, close: 6 },
    plain: { open: 10, close: 6 },
    tooltip: { open: 21, close: 15 },
    "tooltip-quiet-on-focus": { open: 21, close: 15 },
    radio: { open: 14, close: 6 },
    many: { open: 10, close: 6 },
  },
} as const satisfies Record<
  "pointer" | "keyboard",
  Record<Bench, { open: number; close: number }>
>;

for (const how of ["pointer", "keyboard"] as const) {
  test(`a menu opened by ${how} stays within its commits to open and to close`, async ({
    page,
  }) => {
    await page.goto("/dev?visual=menu-commits", {
      waitUntil: "domcontentloaded",
    });
    const measured: { bench: Bench; open: number; close: number }[] = [];
    for (const bench of BENCHES) {
      const trigger = page
        .locator(`[data-playground-section="menu-commits:${bench}"]`)
        .getByRole("button");
      // await-in-loop: one menu is open at a time.
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
      measured.push({
        bench,
        open: opened - atRest,
        close: (await readCommits(page)) - opened,
      });
    }
    // The numbers go to the run's output as well as its report.
    process.stdout.write(
      `menu commits (${how}, ${test.info().project.name}): ${JSON.stringify(measured)}\n`,
    );
    for (const { bench, open, close } of measured) {
      const budget = COMMIT_BUDGET[how][bench];
      expect(open, `${bench} to open`).toBeLessThanOrEqual(budget.open);
      expect(close, `${bench} to close`).toBeLessThanOrEqual(budget.close);
    }
    expect(measured).toHaveLength(BENCHES.length);
  });
}
