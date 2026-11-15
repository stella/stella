import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";
import {
  agentLog,
  AGENTS,
  chooseRunOn,
  composer,
  messagesReceived,
  openNewChat,
  send,
  setComputerOnline,
  transcript,
} from "./computer";

// The stand-in CLIs' `steered` scenario starts a command, waits for a
// message written mid-turn (Codex `turn/steer`, Claude Code a user line it
// echoes back), then answers "Checked the annex as well.".
const STEERED_MODEL = "steered";
const STEER_TEXT = "Also check the annex";

test.beforeEach(async ({ request }) => {
  await setComputerOnline(request, true);
});

for (const agent of ["codex", "claude-code"] as const) {
  test(`${AGENTS[agent].name} takes a message steered into its running turn`, async ({
    page,
  }) => {
    const log = agentLog(agent);
    await openNewChat(page);
    await chooseRunOn(page, {
      place: "computer",
      agent,
      model: STEERED_MODEL,
    });
    await send(page, "Review the lease");

    const steer = page.getByRole("button", {
      name: "Send to the agent while it works",
    });
    await expect(steer).toBeVisible({
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    await composer(page).focus();
    await composer(page).pressSequentially(STEER_TEXT);
    await steer.click();

    await expect(transcript(page)).toContainText("Checked the annex as well.", {
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    // The message sits in the answer as the member's own words, and the
    // turn was not stopped and started again: one answer holds both.
    await expect(
      transcript(page).getByText("Sent while the agent was working"),
    ).toBeVisible();
    await expect(transcript(page)).toContainText(STEER_TEXT);
    expect(
      messagesReceived(log).some((message) => message.includes(STEER_TEXT)),
    ).toBe(true);
    await expect(steer).toHaveCount(0);
  });
}
