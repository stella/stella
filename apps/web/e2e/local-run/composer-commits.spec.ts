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
 * The most commits each step may take: the highest count of three runs that
 * measured the steps one after another on one page, plus a third, which is
 * how far a step's count moved between those runs. A budget only goes down:
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

const openAndClose = async (page: Page, name: string | RegExp) => {
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
};

const onTheComputer = async (page: Page) => {
  await chooseRunOn(page, {
    place: "computer",
    agent: "claude-code",
    model: "tool_calls",
  });
};

/** What each step does, and what the chat needs chosen before it. */
const STEP_ACTIONS = {
  accountMenu: {
    act: async (page) => {
      await openAndClose(page, /test@stella\.dev/u);
    },
  },
  attachmentsMenu: {
    act: async (page) => {
      await openAndClose(page, "Open attachments and tools menu");
    },
  },
  cloudWhereMenu: {
    act: async (page) => {
      await openAndClose(page, "Runs on: Cloud");
    },
  },
  agentAndModel: { act: onTheComputer },
  whereMenu: {
    before: onTheComputer,
    act: async (page) => {
      await widestPermission(page);
    },
  },
  choosePermission: {
    before: onTheComputer,
    act: async (page) => {
      await choosePermission(page, "auto");
    },
  },
  readPermission: {
    before: onTheComputer,
    act: async (page) => {
      await chosenPermission(page);
    },
  },
  typing: {
    act: async (page) => {
      await composer(page).focus();
      await composer(page).pressSequentially(PROMPT);
      await expect(composer(page)).toHaveText(PROMPT);
    },
  },
} as const satisfies Record<
  Step,
  {
    before?: (page: Page) => Promise<void>;
    act: (page: Page) => Promise<void>;
  }
>;

// One step to a test, each on a newly loaded chat. The dev render-storm
// canary reports more than 80 commits in each of two consecutive seconds,
// so 160 at the least; the most a test commits here is its step and the
// choice of the computer before it, about 115 by the measurements above.
for (const key of STEPS) {
  const { step, commits: budget } = COMMIT_BUDGET[key];

  test(`a new chat takes at most ${String(budget)} commits to ${step}`, async ({
    page,
  }) => {
    const action = STEP_ACTIONS[key];
    await openNewChat(page);
    if ("before" in action) {
      await action.before(page);
    }

    // The step ends on the state the member sees: the chips' names, the menu
    // closed, the text typed.
    const before = await readCommits(page);
    await action.act(page);
    const commits = (await readCommits(page)) - before;

    test.info().annotations.push({
      type: "commits",
      description: `${step}: ${String(commits)} of ${String(budget)}`,
    });
    // The number goes to the run's output as well as its report.
    process.stdout.write(
      `composer commits: ${JSON.stringify({ step, commits, budget })}\n`,
    );
    expect(commits, step).toBeLessThanOrEqual(budget);
  });
}
