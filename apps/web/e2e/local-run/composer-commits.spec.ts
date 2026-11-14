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

// How many React commits each step of choosing where a new chat runs takes,
// counted by the dev-only render-storm canary (`RENDER_COMMIT_COUNT_GLOBAL`).
// The steps are the ones a member takes before a first send on their
// computer: the agent and its model, the permission, then the message. Two
// menus that read nothing about the member's computers are measured beside
// them, one outside the composer, because the commits are the shared menu
// component's: every menu takes about as many.

const PROMPT = "Remember where this ran";

/**
 * The most commits each step may take: the highest count of three measured
 * runs plus a third, which is how far one step's count moved between runs (a
 * commit that trails a step counts for the next). A budget only goes down:
 * lower it with the measurement that shows the step commits less.
 */
const COMMIT_BUDGET = {
  accountMenu: { step: "open and close the account menu", commits: 46 },
  attachmentsMenu: {
    step: "open and close the attachments menu",
    commits: 64,
  },
  cloudWhereMenu: {
    step: "open and close the where menu in the cloud",
    commits: 48,
  },
  agentAndModel: { step: "choose the agent and its model", commits: 102 },
  whereMenu: { step: "open and close the where menu", commits: 42 },
  choosePermission: { step: "choose a permission", commits: 52 },
  readPermission: { step: "read the chosen permission", commits: 44 },
  typing: {
    step: `type ${String(PROMPT.length)} characters`,
    commits: 39,
  },
} as const;
type Step = keyof typeof COMMIT_BUDGET;
const STEPS = Object.keys(COMMIT_BUDGET).filter(
  (step): step is Step => step in COMMIT_BUDGET,
);

const readCommits = async (page: Page) =>
  await page.evaluate((key) => {
    const counted: unknown = Reflect.get(globalThis, key);
    return typeof counted === "number" ? counted : 0;
  }, RENDER_COMMIT_COUNT_GLOBAL);

test.beforeEach(async ({ request }) => {
  await setComputerOnline(request, true);
});

test("choosing where a new chat runs and typing its message stay within the commit budget of each step", async ({
  page,
}) => {
  const measured = new Map<Step, number>();
  // Each step ends on the state the member sees (the chips' names, the menu
  // closed, the text typed); a commit that trails it counts for the next.
  const measure = async (step: Step, act: () => Promise<unknown>) => {
    const before = await readCommits(page);
    await act();
    measured.set(step, (await readCommits(page)) - before);
  };
  const openAndClose = async (name: string | RegExp) => {
    await page.getByRole("button", { name }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  };

  await openNewChat(page);
  await measure("accountMenu", async () => {
    await openAndClose(/test@stella\.dev/u);
  });
  await measure("attachmentsMenu", async () => {
    await openAndClose("Open attachments and tools menu");
  });
  await measure("cloudWhereMenu", async () => {
    await openAndClose("Runs on: Cloud");
  });
  await measure("agentAndModel", async () => {
    await chooseRunOn(page, {
      place: "computer",
      agent: "claude-code",
      model: "tool_calls",
    });
  });
  let widest: Awaited<ReturnType<typeof widestPermission>> = "auto";
  await measure("whereMenu", async () => {
    widest = await widestPermission(page);
  });
  await measure("choosePermission", async () => {
    await choosePermission(page, widest);
  });
  await measure("readPermission", async () => {
    await chosenPermission(page);
  });
  await measure("typing", async () => {
    await composer(page).focus();
    await composer(page).pressSequentially(PROMPT);
    await expect(composer(page)).toHaveText(PROMPT);
  });

  const report = STEPS.map((key) => ({
    step: COMMIT_BUDGET[key].step,
    commits: measured.get(key),
    budget: COMMIT_BUDGET[key].commits,
  }));
  // The numbers go to the run's output as well as its report.
  process.stdout.write(`composer commits: ${JSON.stringify(report)}\n`);
  for (const { step, commits, budget } of report) {
    test.info().annotations.push({
      type: "commits",
      description: `${step}: ${String(commits)} of ${String(budget)}`,
    });
    expect(commits, step).toBeDefined();
    expect(commits ?? 0, step).toBeLessThanOrEqual(budget);
  }
});
