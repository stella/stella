import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";

import { E2E_API_ORIGIN } from "../helpers/api";
import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";
import {
  agentLog,
  chooseRunOn,
  filesWritten,
  messagesReceived,
  openNewChat,
  relinkComputer,
  send,
  setComputerOnline,
  transcript,
} from "./computer";

// Turns whose computer goes away, links again, or undoes what a turn wrote.
// The pickup limit is the API's `E2E_DESKTOP_RUNNER_PICKUP_MS` (4 s in CI),
// so a turn its computer never picks up fails in seconds.

const TEXT_ANSWER =
  "Lease one is the office lease; lease two is the warehouse.";
/** `writes_file` adds notes.md to the run's folder, then answers this. */
const WROTE_ANSWER = "Wrote notes.md.";
/** What the next turn tells the agent after an undo (control.ts). */
const UNDONE_NOTE = "the member undid the file changes of an earlier reply";
const UNDO_REQUEST =
  /\/chat\/threads\/[^/]+\/turns\/[^/]+\/local-files\/undo$/u;

test.beforeEach(async ({ request }) => {
  await setComputerOnline(request, true);
});

test.afterEach(async ({ request }) => {
  await setComputerOnline(request, true);
});

/** A chat whose newest turn wrote a file on the computer; that file. */
const writeNotes = async (page: Page) => {
  const log = agentLog("codex");
  await openNewChat(page);
  await chooseRunOn(page, {
    place: "computer",
    agent: "codex",
    model: "writes_file",
  });
  await send(page, "Write the notes");
  await expect(transcript(page)).toContainText(WROTE_ANSWER, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  const written = filesWritten(log);
  expect(written).toHaveLength(1);
  const [file = ""] = written;
  expect(existsSync(file), `${file} is on the computer`).toBe(true);
  return file;
};

const answerActions = (page: Page, answer: string) =>
  transcript(page)
    .locator("[data-chat-message-id]")
    .filter({ hasText: answer })
    .getByRole("button", { name: "Actions" });

const askToUndo = async (page: Page) => {
  await answerActions(page, WROTE_ANSWER).click();
  await page.getByRole("menuitem", { name: "Undo file changes" }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Undo this turn's file changes?",
  });
  await dialog.getByRole("button", { name: "Undo changes" }).click();
};

test("undo removes what the newest turn wrote, and the next turn is told", async ({
  page,
  request,
}) => {
  const file = await writeNotes(page);

  const undoRequest = page.waitForRequest(
    (sent) => sent.method() === "POST" && UNDO_REQUEST.test(sent.url()),
  );
  await askToUndo(page);
  const undoUrl = new URL((await undoRequest).url());

  const marker = transcript(page).locator('[data-local-files-undo="restored"]');
  await expect(marker).toHaveText("File changes undone", {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect.poll(() => existsSync(file)).toBe(false);

  // The next turn carries the note, so the agent reads files again.
  const log = agentLog("codex");
  await chooseRunOn(page, { place: "computer", agent: "codex", model: "text" });
  await send(page, "What is in the folder now?");
  await expect(transcript(page)).toContainText(TEXT_ANSWER, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  expect(
    messagesReceived(log).some((message) => message.includes(UNDONE_NOTE)),
  ).toBe(true);

  // The marker stays with the older turn, which can no longer be undone:
  // its answer offers no undo, and the API refuses one.
  await page.reload();
  await expect(marker).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await answerActions(page, WROTE_ANSWER).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Undo file changes" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  const refused = await request.post(`${E2E_API_ORIGIN}${undoUrl.pathname}`);
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({
    status: "refused",
    reason: "not_newest",
  });
});

test("undo is refused while the computer is offline, and the file stays", async ({
  page,
  request,
}) => {
  const file = await writeNotes(page);
  await setComputerOnline(request, false);

  await askToUndo(page);

  await expect(transcript(page)).toContainText(
    "Your computer is offline. Open the stella desktop app and try again.",
    { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
  );
  await expect(
    transcript(page).locator('[data-local-files-undo="restored"]'),
  ).toHaveCount(0);
  expect(existsSync(file)).toBe(true);
});

test("a turn sent while the computer is offline waits for it, then fails as not reached", async ({
  page,
  request,
}) => {
  await openNewChat(page);
  await chooseRunOn(page, { place: "computer", agent: "codex", model: "text" });
  await setComputerOnline(request, false);

  await send(page, "Are you there?");

  await expect(
    transcript(page)
      .getByRole("status")
      .filter({ hasText: "Waiting for your computer to pick up this turn" }),
  ).toBeVisible({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
  await expect(transcript(page)).toContainText(
    "Your computer did not pick up this turn.",
    { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
  );

  // Once the computer is back, sending again reaches it.
  await setComputerOnline(request, true);
  await page.getByRole("button", { name: "Resend" }).click();
  await expect(transcript(page)).toContainText(TEXT_ANSWER, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
});

test("a computer linked again ends the run its old link held, and the next turn reaches the new link", async ({
  page,
  request,
}) => {
  await openNewChat(page);
  await chooseRunOn(page, {
    place: "computer",
    agent: "codex",
    model: "slow_text",
  });
  await send(page, "Answer slowly");
  await expect(transcript(page)).toContainText("Lease one", {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });

  await relinkComputer(request);

  await expect(transcript(page)).toContainText(
    "stella desktop was linked again on your computer, so this turn stopped. Send it again.",
    { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
  );

  await chooseRunOn(page, { place: "computer", agent: "codex", model: "text" });
  await send(page, "Once more");
  await expect(transcript(page)).toContainText(TEXT_ANSWER, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
});
