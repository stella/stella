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
    await card.getByRole("button", { name: /^Czech/u }).click();
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

test("a computer turn that reaches the agent's usage limit says when it resets", async ({
  page,
}) => {
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
