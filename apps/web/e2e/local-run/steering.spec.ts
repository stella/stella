import type { Page } from "@playwright/test";

import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";
import {
  agentLog,
  AGENTS,
  chooseRunOn,
  composer,
  expandTranscript,
  expectTurnsFinished,
  messagesReceived,
  openNewChat,
  send,
  setComputerOnline,
  transcript,
} from "./computer";

// The stand-in CLIs' `steered` scenario starts a command, waits for a
// message written mid-turn (Codex `turn/steer`, Claude Code a user line it
// echoes back), then answers "Checked the annex as well.".
// `steered_over_approval` asks to run `rm draft.md` first and waits for the
// message after the member's decision.
const STEER_TEXT = "Also check the annex";
const STEERED_LABEL = "Sent while the agent was working";

/**
 * The steered message's own caption in the answer, once the finished turn's
 * steps are open (the turn's live status can say the same while it works).
 */
const expectSteeredInAnswer = async (page: Page) => {
  await expectTurnsFinished(page, 1);
  await expandTranscript(page);
  await expect(
    transcript(page).locator("figcaption").filter({ hasText: STEERED_LABEL }),
  ).toBeVisible();
  await expect(transcript(page)).toContainText(STEER_TEXT);
};

/** The composer's queue action, offered while Enter steers the turn. */
const queueButton = (page: Page) =>
  page.getByRole("button", { name: "Send when the agent finishes" });

const typeIntoComposer = async (page: Page, text: string) => {
  await composer(page).focus();
  await composer(page).pressSequentially(text);
};

test.beforeEach(async ({ request }) => {
  await setComputerOnline(request, true);
});

for (const agent of ["codex", "claude-code"] as const) {
  const { name } = AGENTS[agent];

  test(`${name} takes a message sent with Enter while it works`, async ({
    page,
  }) => {
    const log = agentLog(agent);
    await openNewChat(page);
    await chooseRunOn(page, { place: "computer", agent, model: "steered" });
    await send(page, "Review the lease");

    // While the agent works, Enter steers and a button queues instead.
    await expect(queueButton(page)).toBeVisible({
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    await typeIntoComposer(page, STEER_TEXT);
    await composer(page).press("Enter");

    await expect(transcript(page)).toContainText("Checked the annex as well.", {
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    // The message sits in the answer as the member's own words, and the
    // turn was not stopped and started again: one answer holds both.
    await expectSteeredInAnswer(page);
    expect(
      messagesReceived(log).some((message) => message.includes(STEER_TEXT)),
    ).toBe(true);
    await expect(queueButton(page)).toHaveCount(0);
  });

  test(`${name} is told no to its request when a message is sent over it, and goes on with the message`, async ({
    page,
  }) => {
    const log = agentLog(agent);
    await openNewChat(page);
    await chooseRunOn(page, {
      place: "computer",
      agent,
      model: "steered_over_approval",
    });
    await send(page, "Remove the draft");
    await expect(
      transcript(page).getByRole("button", { name: "Allow once" }),
    ).toBeVisible({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });

    await typeIntoComposer(page, STEER_TEXT);
    await composer(page).press("Enter");

    // The request is declined in the transcript, as the member's own Deny
    // would decline it, and the message follows it in the same answer.
    await expect(
      transcript(page).getByRole("img", { name: "Denied" }),
    ).toBeVisible({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
    await expect(transcript(page)).toContainText(
      "Left the draft and checked the annex.",
      { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
    );
    await expectSteeredInAnswer(page);
    await expect(
      transcript(page).getByRole("button", { name: "Allow once" }),
    ).toHaveCount(0);
    // The agent heard the decision, then the message.
    await expect
      .poll(() => log.entries().some((entry) => "decision" in entry))
      .toBe(true);
    expect(
      messagesReceived(log).some((message) => message.includes(STEER_TEXT)),
    ).toBe(true);
  });
}

test("Cmd/Ctrl+Enter queues a message until the working turn ends", async ({
  page,
}) => {
  const log = agentLog("codex");
  await openNewChat(page);
  await chooseRunOn(page, {
    place: "computer",
    agent: "codex",
    model: "slow_text",
  });
  await send(page, "Answer slowly");
  await expect(queueButton(page)).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });

  await typeIntoComposer(page, STEER_TEXT);
  await composer(page).press("ControlOrMeta+Enter");
  const queued = page.getByText(
    "Queued: sends when the current response finishes",
  );
  await expect(queued).toBeVisible();

  // Sent as the next message once the turn ends, never into the turn.
  await expect(queued).toHaveCount(0, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS * 2,
  });
  await expect(
    transcript(page).getByText(STEER_TEXT, { exact: true }),
  ).toBeVisible();
  await expect(transcript(page).getByText(STEERED_LABEL)).toHaveCount(0);
  expect(
    messagesReceived(log).some((message) => message.includes("turn/steer")),
  ).toBe(false);
});
