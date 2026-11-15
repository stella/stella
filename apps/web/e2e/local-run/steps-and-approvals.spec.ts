import type { Page } from "@playwright/test";

import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";
import {
  type Agent,
  agentLog,
  AGENTS,
  chooseRunOn,
  expandTranscript,
  expectTurnsFinished,
  openNewChat,
  send,
  setComputerOnline,
  transcript,
} from "./computer";

// What the stand-in CLIs' `native_tools` and `harness_items` scenarios do
// (packages/agent-engine/scripts/fake-codex-app-server.ts and
// fake-claude-code-cli.ts): the steps chat names, what an opened step shows
// as stella stored it (a command's output, a change's diff), and the text
// their inputs carry that chat must never show.
const STEPS = {
  codex: {
    model: "native_tools",
    shown: [
      "Running a command",
      `/bin/zsh -lc "cat > notes.md <<'EOF'`,
      "Changing files",
      "/workspace/drafts/lease.md, /workspace/drafts/notice.md",
    ],
    stored: ["zsh: permission denied", "Rent is due quarterly."],
    hidden: [
      "Tenant owes 4,200 in arrears.",
      "Working through the private plan",
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
    stored: ["Rent is due quarterly."],
    hidden: [
      "Tenant owes 4,200 in arrears.",
      "Summarise the termination rules",
      "Working through the private plan",
    ],
  },
} as const satisfies Record<
  Agent,
  {
    model: string;
    shown: readonly string[];
    stored: readonly string[];
    hidden: readonly string[];
  }
>;

/**
 * Where stella desktop's loopback bridge served a step's output before
 * stella stored it: no page reads a step from the computer any more.
 */
const STEP_OUTPUT_ON_THIS_COMPUTER =
  /^http:\/\/127\.0\.0\.1:\d+\/v1\/runs\/[^/]+\/steps\/[^/]+\/output$/u;

/** Every read of a step from the computer the page attempts. */
const loopbackReads = async (page: Page) => {
  const reads: string[] = [];
  await page.route(STEP_OUTPUT_ON_THIS_COMPUTER, async (route) => {
    reads.push(route.request().url());
    await route.abort("connectionrefused");
  });
  return reads;
};

const expectStepsAsStored = async (page: Page, agent: Agent) => {
  for (const text of STEPS[agent].shown) {
    // await-in-loop: each named step part, checked in turn.
    await expect(
      transcript(page).getByText(text, { exact: false }).first(),
    ).toBeVisible();
  }
  // An opened command or file change shows what stella stored of it.
  for (const text of STEPS[agent].stored) {
    // await-in-loop: each stored output, checked in turn.
    await expect(
      transcript(page).getByText(text, { exact: false }).first(),
    ).toBeVisible();
  }
  // What a step was given is never shown, opened or not.
  const shown = (await transcript(page).textContent()) ?? "";
  for (const text of STEPS[agent].hidden) {
    expect(shown, `chat holds "${text}"`).not.toContain(text);
  }
};

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

  test(`${name} steps show what they ran on, and their output as stella stored it`, async ({
    page,
  }) => {
    const reads = await loopbackReads(page);
    await openNewChat(page);
    await chooseRunOn(page, {
      place: "computer",
      agent,
      model: STEPS[agent].model,
    });
    await send(page, "Draft the notice");

    await expectTurnsFinished(page, 1);
    expect(await expandTranscript(page)).toBeGreaterThan(0);
    await expectStepsAsStored(page, agent);

    // The same after a reload, from what the server stored.
    await page.reload({ waitUntil: "commit" });
    await expectTurnsFinished(page, 1);
    await expandTranscript(page);
    await expectStepsAsStored(page, agent);
    expect(reads).toEqual([]);
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
