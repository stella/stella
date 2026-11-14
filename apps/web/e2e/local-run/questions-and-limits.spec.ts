import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";
import {
  agentLog,
  AGENTS,
  chooseRunOn,
  messagesReceived,
  openNewChat,
  send,
  setComputerOnline,
  transcript,
} from "./computer";

// The stand-in CLIs' question scenarios (`blocking_question` for Codex,
// `question` for Claude Code) ask which law governs the lease and answer
// "Using Czech law." once told.
const QUESTION_MODELS = {
  codex: "blocking_question",
  "claude-code": "question",
} as const;

/** The chat's read of its thread, which follows every settled turn. */
const THREAD_MESSAGES = /\/v1\/chat\/threads\/[^/]+\/messages(?:\?|$)/u;

test.beforeEach(async ({ request }) => {
  await setComputerOnline(request, true);
});

for (const agent of ["codex", "claude-code"] as const) {
  test(`${AGENTS[agent].name} asks a blocking question and goes on with the answer given in chat`, async ({
    page,
  }) => {
    const log = agentLog(agent);
    await openNewChat(page);
    await chooseRunOn(page, {
      place: "computer",
      agent,
      model: QUESTION_MODELS[agent],
    });
    await send(page, "Which law applies?");

    const card = transcript(page).locator("[data-local-run-question]");
    await expect(card).toContainText("Which law governs the lease?", {
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    const submit = card.getByRole("button", { name: "Submit answers" });
    await expect(submit).toBeDisabled();
    const czech = card.getByRole("button", { name: /^Czech/u });
    await czech.click();
    // The pick is the card's own state: it has to hold before the answer
    // can be sent.
    await expect(czech).toHaveAttribute("aria-pressed", "true");
    await submit.click();

    await expect(transcript(page)).toContainText("Using Czech law.", {
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    // The answer reached the agent on the computer.
    expect(
      messagesReceived(log).some((message) => message.includes("Czech")),
    ).toBe(true);
    await expect(
      card.getByRole("button", { name: "Submit answers" }),
    ).toHaveCount(0);
  });
}

test("an option picked as soon as a question shows holds while the chat reads the thread again", async ({
  page,
}) => {
  // Thread reads are held from the moment the question shows, so the pick
  // lands before the read that follows the pause.
  const hold = { active: false, held: 0 };
  const released = Promise.withResolvers<null>();
  await page.route(THREAD_MESSAGES, async (route) => {
    if (hold.active) {
      hold.held += 1;
      await released.promise;
    }
    await route.continue();
  });
  await openNewChat(page);
  await chooseRunOn(page, {
    place: "computer",
    agent: "codex",
    model: QUESTION_MODELS.codex,
  });
  await send(page, "Which law applies?");

  const card = transcript(page).locator("[data-local-run-question]");
  await expect(card).toContainText("Which law governs the lease?", {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  hold.active = true;
  const czech = card.getByRole("button", { name: /^Czech/u });
  await czech.click();
  await expect(czech).toHaveAttribute("aria-pressed", "true");
  // The read that follows the pause is waiting: the pick came first.
  await expect.poll(() => hold.held).toBeGreaterThan(0);

  const threadRead = page.waitForResponse(
    (response) => THREAD_MESSAGES.test(response.url()),
    { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
  );
  released.resolve(null);
  await threadRead;

  await expect(czech).toHaveAttribute("aria-pressed", "true");
  await card.getByRole("button", { name: "Submit answers" }).click();
  await expect(transcript(page)).toContainText("Using Czech law.", {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
});

test("a computer turn that reaches the agent's usage limit says when it resets", async ({
  page,
  browserErrors,
}) => {
  // The development build echoes the turn's failure to the console.
  browserErrors.expectCaptured(/local_runner_limit_reached/u);
  await openNewChat(page);
  await chooseRunOn(page, {
    place: "computer",
    agent: "codex",
    model: "usage_limit",
  });
  await send(page, "Read the lease");

  const message = transcript(page).getByText(
    /reached its usage limit\. You can try again after/u,
  );
  await expect(message).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  // The reset as the member's locale writes a date and time (the stand-in
  // resets an hour after the turn).
  await expect(message).toHaveText(
    /You can try again after [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M\./u,
  );
});
