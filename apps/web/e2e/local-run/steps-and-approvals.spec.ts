import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";
import {
  type Agent,
  agentLog,
  AGENTS,
  chooseRunOn,
  expandTranscript,
  openNewChat,
  send,
  setComputerOnline,
  transcript,
} from "./computer";

// What the stand-in CLIs' `native_tools` and `harness_items` scenarios do
// (packages/agent-engine/scripts/fake-codex-app-server.ts and
// fake-claude-code-cli.ts): the steps chat names, and the text their inputs
// and outputs carry that chat must never show.
const STEPS = {
  codex: {
    model: "native_tools",
    shown: [
      "Running a command",
      `/bin/zsh -lc "cat > notes.md <<'EOF'`,
      "Changing files",
      "/workspace/drafts/lease.md, /workspace/drafts/notice.md",
    ],
    hidden: [
      "Tenant owes 4,200 in arrears.",
      "Rent is due quarterly.",
      "Working through the private plan",
      "zsh: permission denied",
    ],
  },
  "claude-code": {
    model: "native_tools",
    shown: [
      "Running a command",
      "cat > notes.md <<'EOF'",
      "/workspace/drafts/lease.md",
      "/elsewhere/out.md",
      "termination",
      "civil code lease",
    ],
    hidden: [
      "Tenant owes 4,200 in arrears.",
      "Rent is due monthly.",
      "Rent is due quarterly.",
      "Confidential settlement terms.",
      "Summarise the termination rules",
      "Working through the private plan",
      "lease.md: termination",
    ],
  },
} as const satisfies Record<
  Agent,
  { model: string; shown: readonly string[]; hidden: readonly string[] }
>;

// `approval_outcome`: asks to run `rm draft.md`, then answers by the decision.
const APPROVAL = {
  codex: { approved: "Removed draft.md.", denied: "Left it in place." },
  "claude-code": {
    approved: "Removed draft.md.",
    denied: "Left the draft in place.",
  },
} as const satisfies Record<Agent, { approved: string; denied: string }>;

test.beforeEach(async ({ request }) => {
  await setComputerOnline(request, true);
});

for (const agent of ["codex", "claude-code"] as const) {
  const { name } = AGENTS[agent];

  test(`${name} steps show what they ran on and never their output or file contents`, async ({
    page,
  }) => {
    await openNewChat(page);
    await chooseRunOn(page, {
      place: "computer",
      agent,
      model: STEPS[agent].model,
    });
    await send(page, "Draft the notice");

    await expect(transcript(page).getByText(/^Worked for/u)).toBeVisible({
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    expect(await expandTranscript(page)).toBeGreaterThan(0);
    const shown = await transcript(page).innerText();
    for (const text of STEPS[agent].shown) {
      expect(shown, `chat does not show "${text}"`).toContain(text);
    }
    for (const text of STEPS[agent].hidden) {
      expect(shown, `chat showed "${text}"`).not.toContain(text);
    }

    // The same after a reload, from what the server kept.
    await page.reload();
    await expect(transcript(page)).toContainText(STEPS[agent].shown[0], {
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    await expandTranscript(page);
    const reloaded = await transcript(page).innerText();
    for (const text of STEPS[agent].hidden) {
      expect(reloaded, `chat showed "${text}" after a reload`).not.toContain(
        text,
      );
    }
  });

  for (const decision of ["approved", "denied"] as const) {
    test(`${name} runs a command only once it is approved (${decision})`, async ({
      page,
    }) => {
      const log = agentLog(agent);
      await openNewChat(page);
      await chooseRunOn(page, {
        place: "computer",
        agent,
        model: "approval_outcome",
      });
      await send(page, "Remove the draft");

      const allow = transcript(page).getByRole("button", {
        name: "Allow once",
      });
      await expect(allow).toBeVisible({
        timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
      });
      await expect(transcript(page)).toContainText("Running a command");
      // Nothing ran while the request waits.
      await expect(transcript(page)).not.toContainText(
        APPROVAL[agent].approved,
      );

      if (decision === "approved") {
        await allow.click();
      } else {
        await transcript(page).getByRole("button", { name: "Deny" }).click();
      }

      await expect(
        transcript(page).getByRole("img", {
          name: decision === "approved" ? "Allowed" : "Denied",
        }),
      ).toBeVisible({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
      await expect(transcript(page)).toContainText(APPROVAL[agent][decision], {
        timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
      });
      const other = decision === "approved" ? "denied" : "approved";
      await expect(transcript(page)).not.toContainText(APPROVAL[agent][other]);
      // The agent was told the member's decision.
      await expect
        .poll(() => log.entries().some((entry) => "decision" in entry))
        .toBe(true);
    });
  }
}
