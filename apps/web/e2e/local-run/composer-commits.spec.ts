import type { Page } from "@playwright/test";

import { RENDER_COMMIT_COUNT_GLOBAL } from "../../src/lib/render-storm-canary";
import { expect, test } from "../helpers/test";
import {
  choosePermission,
  chooseRunOn,
  chosenPermission,
  composer,
  openNewChat,
  setComputerOnline,
  widestPermission,
} from "./computer";

// What each step of choosing where a new chat runs costs the page in React
// commits, counted by the dev-only render-storm canary
// (`RENDER_COMMIT_COUNT_GLOBAL`). The steps are the ones a member takes
// before a first send on their computer: the agent and its model, the
// permission, then the message.

const PROMPT = "Remember where this ran";

const readCommits = async (page: Page) =>
  await page.evaluate((key) => {
    const counted: unknown = Reflect.get(globalThis, key);
    return typeof counted === "number" ? counted : 0;
  }, RENDER_COMMIT_COUNT_GLOBAL);

type Measured = { step: string; commits: number };

test.beforeEach(async ({ request }) => {
  await setComputerOnline(request, true);
});

test("choosing where a new chat runs and typing its message stay within the commit budget of each step", async ({
  page,
}) => {
  const measured: Measured[] = [];
  // Each step ends on the state the member sees (the chips' names, the menu
  // closed, the text typed); a commit that trails it counts for the next.
  const measure = async (step: string, act: () => Promise<unknown>) => {
    const before = await readCommits(page);
    await act();
    measured.push({ step, commits: (await readCommits(page)) - before });
  };

  await openNewChat(page);
  // For comparison: a menu of the same composer that reads nothing about
  // the member's computers.
  const openAndClose = async (name: string | RegExp) => {
    await page.getByRole("button", { name }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  };
  // And one outside the composer: the account menu of the sidebar.
  await measure("open and close the account menu", async () => {
    await openAndClose(/test@stella\.dev/u);
  });
  await measure("open and close the attachments menu", async () => {
    await openAndClose("Open attachments and tools menu");
  });
  await measure("open and close the cloud where menu", async () => {
    await openAndClose("Runs on: Cloud");
  });
  await measure("choose the agent and its model", async () => {
    await chooseRunOn(page, {
      place: "computer",
      agent: "claude-code",
      model: "tool_calls",
    });
  });
  let widest: Awaited<ReturnType<typeof widestPermission>> = "auto";
  await measure("open and close the where menu", async () => {
    widest = await widestPermission(page);
  });
  await measure("choose a permission", async () => {
    await choosePermission(page, widest);
  });
  await measure("read the chosen permission", async () => {
    await chosenPermission(page);
  });
  await measure(`type ${String(PROMPT.length)} characters`, async () => {
    await composer(page).focus();
    await composer(page).pressSequentially(PROMPT);
    await expect(composer(page)).toHaveText(PROMPT);
  });

  for (const { step, commits } of measured) {
    test.info().annotations.push({
      type: "commits",
      description: `${step}: ${String(commits)}`,
    });
  }
  // The numbers go to the run's output as well as its report.
  process.stdout.write(`composer commits: ${JSON.stringify(measured)}\n`);
  expect(measured).toHaveLength(8);
});
