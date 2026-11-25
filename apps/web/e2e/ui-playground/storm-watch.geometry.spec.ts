/**
 * The storm watch sees storms, and only storms.
 *
 * Every spec on the shared fixture runs under the storm watch
 * (e2e/helpers/storm-watch.ts). This spec holds the watch itself to both
 * halves of its job on the dev playground: menus opened as fast as a test
 * drives them are input, not a storm (the false alarm the old rate canary
 * raised on the composer's menus), while a loop one click started and
 * nothing keeps feeding is a storm, at frame rate or far below it. A storm
 * on a page the test opened beside its own, and closed, still counts.
 */

import { expect, type Page, test } from "@playwright/test";

import { DEFAULT_QUIESCENCE_LIMITS } from "@stll/render-probe/storm-ledger";

import { menuCommitBenches } from "../../src/routes/dev/-visual-metadata";
import {
  addStormWatch,
  stormWatchChecks,
  stormWatchFailures,
} from "../helpers/storm-watch";
import {
  readStormWatch,
  STORM_WATCH_GLOBAL,
  type StormWatchRead,
} from "../helpers/storm-watch-contract";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";

// What the watch sees does not depend on the theme or reading direction.
const MEASURED_PROJECT = "light-ltr";

const read = async (page: Page): Promise<StormWatchRead> => {
  const result = await page.evaluate(readStormWatch, {
    global: STORM_WATCH_GLOBAL,
    ...DEFAULT_QUIESCENCE_LIMITS,
  });
  if (result === null) {
    throw new TypeError("The page has no storm watch");
  }
  return result;
};

// The click refills the bucket, so a loop drains it only after a few seconds,
// longer on a slow machine where frames come slower: read until it has.
const readUntilReported = async (page: Page): Promise<StormWatchRead> => {
  let watched: StormWatchRead | undefined;
  await expect
    .poll(
      async () => {
        watched = await read(page);
        return watched.report.reported.length;
      },
      { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
    )
    .toBeGreaterThan(0);
  if (watched === undefined) {
    throw new TypeError("The storm watch was never read");
  }
  return watched;
};

test.beforeEach(async ({ context }, testInfo) => {
  test.skip(
    testInfo.project.name !== MEASURED_PROJECT,
    `The storm watch is checked in the ${MEASURED_PROJECT} project only.`,
  );
  await addStormWatch(context);
});

test("menus opened and closed as fast as a test can are not a storm", async ({
  page,
}) => {
  await page.goto("/dev?visual=menu-commits", {
    waitUntil: "domcontentloaded",
  });
  const menu = page.getByRole("menu");
  for (let round = 0; round < 2; round += 1) {
    for (const bench of Object.keys(menuCommitBenches)) {
      await page
        .locator(`[data-playground-section="menu-commits:${bench}"]`)
        .getByRole("button")
        .click();
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
  }

  const watched = await read(page);
  expect(watched.report.commits, "commits counted").toBeGreaterThan(0);
  expect(stormWatchFailures(watched)).toEqual([]);
  expect(watched.quiescence.verdict).toBe("quiet");
});

test("a loop at frame rate that nothing feeds is a storm, and the report names it", async ({
  page,
}) => {
  await page.goto("/dev?visual=storm-watch", {
    waitUntil: "domcontentloaded",
  });
  await page
    .locator('[data-playground-section="storm-watch:frame-loop"]')
    .getByRole("button")
    .click();

  const watched = await readUntilReported(page);
  const [unstimulated] = watched.report.reported;
  expect(unstimulated, "an unstimulated violation").toBeDefined();
  expect(unstimulated?.components.map(({ name }) => name)).toContain(
    "FrameLoop",
  );
  expect(watched.quiescence.verdict).toBe("storm");
});

test("a loop too slow for any rate threshold still never goes quiet", async ({
  page,
}) => {
  await page.goto("/dev?visual=storm-watch", {
    waitUntil: "domcontentloaded",
  });
  await page
    .locator('[data-playground-section="storm-watch:slow-loop"]')
    .getByRole("button")
    .click();

  const watched = await read(page);
  expect(watched.quiescence.verdict).toBe("storm");
  expect(watched.quiescence.components.map(({ name }) => name)).toContain(
    "SlowLoop",
  );
  expect(stormWatchFailures(watched).length).toBeGreaterThan(0);
});

test("a storm on a page the test opened and closed still counts", async ({
  context,
  page,
}) => {
  const beside = await context.newPage();
  await beside.goto("/dev?visual=storm-watch", {
    waitUntil: "domcontentloaded",
  });
  await beside
    .locator('[data-playground-section="storm-watch:frame-loop"]')
    .getByRole("button")
    .click();
  // The page has reported before it closes.
  await readUntilReported(beside);
  await beside.close();

  const checks = await stormWatchChecks(context, page);
  const closed = checks.find(({ annotation }) => annotation["closed"] === true);
  expect(closed?.page, "the closed page is checked").toBe(1);
  expect(closed?.failures.join("\n")).toContain("FrameLoop");
});
