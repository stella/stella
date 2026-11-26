import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";
import {
  type Agent,
  agentLog,
  AGENTS,
  choosePermission,
  chooseRunOn,
  chosenPermission,
  expectRunOn,
  expectTurnsFinished,
  messagesReceived,
  modelsOffered,
  openNewChat,
  send,
  setComputerOnline,
  stopButton,
  THREAD_URL,
  transcript,
  widestPermission,
} from "./computer";

// The stand-in CLIs' scenarios, named by the models they list
// (packages/agent-engine/scripts/fake-*-by-model.ts), and what they answer.
const ANSWERS = {
  codex: {
    model: "text",
    answer: "Lease one is the office lease; lease two is the warehouse.",
  },
  "claude-code": { model: "tool_calls", answer: "Found two leases." },
} as const satisfies Record<Agent, { model: string; answer: string }>;

test.beforeEach(async ({ request }) => {
  await setComputerOnline(request, true);
});

for (const agent of ["codex", "claude-code"] as const) {
  test(`a new chat set to run on the computer with ${AGENTS[agent].name} answers from the computer on its first send`, async ({
    page,
  }) => {
    const log = agentLog(agent);
    const prompt = `Which leases do we hold? (${agent} first send)`;
    await openNewChat(page);
    await chooseRunOn(page, {
      place: "computer",
      agent,
      model: ANSWERS[agent].model,
    });

    await send(page, prompt);

    await expect(page).toHaveURL(THREAD_URL, {
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    await expect(transcript(page)).toContainText(ANSWERS[agent].answer, {
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    // The prompt reached the agent on the computer, not a stella model.
    expect(
      messagesReceived(log).some((message) => message.includes(prompt)),
    ).toBe(true);

    // The chat keeps its place and its answer from the server.
    await expectTurnsFinished(page, 1);
    await page.reload({ waitUntil: "commit" });
    await expect(transcript(page)).toContainText(ANSWERS[agent].answer, {
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    await expectRunOn(page, {
      place: "computer",
      agent,
      model: ANSWERS[agent].model,
    });
  });
}

test("the model chip offers the models of the agent chosen in the where chip, and no other's", async ({
  page,
}) => {
  // `blocking_question` is a scenario of the Codex stand-in alone, `question`
  // of the Claude Code one.
  const models = ["blocking_question", "question"];
  await openNewChat(page);
  await chooseRunOn(page, { place: "computer", agent: "codex", model: "text" });
  expect(await modelsOffered(page, "codex", models)).toEqual([true, false]);

  await chooseRunOn(page, {
    place: "computer",
    agent: "claude-code",
    model: "tool_calls",
  });
  expect(await modelsOffered(page, "claude-code", models)).toEqual([
    false,
    true,
  ]);
});

test("the elapsed time of a computer turn counts up while it runs", async ({
  page,
}) => {
  await page.clock.install();
  await openNewChat(page);
  await chooseRunOn(page, {
    place: "computer",
    agent: "codex",
    model: "slow_text",
  });
  await send(page, "Count while you answer");

  const status = page.locator("[data-turn-live-status]");
  await expect(status).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await page.clock.runFor(5000);
  // The phase and the count are separate nodes, read as one text.
  await expect(status).toHaveText(/\D(?:[5-9]|\d{2,})s$/u);
  await stopButton(page).click();
});

test("Stop ends a computer turn mid-answer and the agent is interrupted", async ({
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

  // The first words stream before Stop.
  await expect(transcript(page)).toContainText("Lease one", {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await stopButton(page).click();

  await expect(
    transcript(page).getByRole("status").filter({ hasText: "Stopped" }),
  ).toBeVisible({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
  await expect
    .poll(() =>
      messagesReceived(log).some((message) =>
        message.includes('"turn/interrupt"'),
      ),
    )
    .toBe(true);
  await expect(transcript(page)).not.toContainText("the warehouse.");
});

test("new chats start on the last Run on choice, and on Ask whatever permission was chosen before", async ({
  page,
}) => {
  await openNewChat(page);
  await chooseRunOn(page, {
    place: "computer",
    agent: "claude-code",
    model: "tool_calls",
  });
  const widest = await widestPermission(page);
  test.info().annotations.push({ type: "permission", description: widest });
  await choosePermission(page, widest);
  expect(await chosenPermission(page)).toEqual([widest]);
  await send(page, "Remember where this ran");
  await expect(transcript(page)).toContainText(ANSWERS["claude-code"].answer, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expectTurnsFinished(page, 1);

  await openNewChat(page);
  await expectRunOn(page, {
    place: "computer",
    agent: "claude-code",
    model: "tool_calls",
  });
  expect(await chosenPermission(page)).toEqual(["ask"]);

  // Back in the cloud, the next new chat starts there.
  await chooseRunOn(page, { place: "cloud" });
  await openNewChat(page);
  await expectRunOn(page, { place: "cloud" });
});
