import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";

import { E2E_API_ORIGIN } from "../helpers/api";
import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";
import {
  agentLog,
  chooseRunOn,
  composer,
  filesWritten,
  messagesReceived,
  openNewChat,
  relinkComputer,
  send,
  setComputerOnline,
  THREAD_URL,
  transcript,
} from "./computer";

// Turns whose computer goes away, links again, or undoes what a turn wrote.

const TEXT_ANSWER =
  "Lease one is the office lease; lease two is the warehouse.";
/** `writes_file` adds notes.md to the run's folder, then answers this. */
const WROTE_ANSWER = "Wrote notes.md.";
/** What the next turn tells the agent after an undo (control.ts). */
const UNDONE_NOTE = "the member undid the file changes of an earlier reply";
const UNDO_REQUEST =
  /\/chat\/threads\/[^/]+\/turns\/[^/]+\/local-files\/undo$/u;
/**
 * Undo is not offered on the stand-in computer: the turn's undo read answers
 * `undoable: false` for the newest turn although its folder was saved before
 * the turn, also after the chat is loaded again. Remove once it is offered.
 */
const UNDO_NOT_OFFERED =
  "Undo is not offered: GET .../local-files/undo answers undoable false for the newest turn that wrote a file.";

/** The send's refusal while none of the member's computers is connected. */
const NO_COMPUTER = "None of your computers is connected.";

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

const undoItem = (page: Page) =>
  page.getByRole("menuitem", { name: "Undo file changes" });

const askToUndo = async (page: Page) => {
  await answerActions(page, WROTE_ANSWER).click();
  await undoItem(page).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Undo this turn's file changes?",
  });
  await dialog.getByRole("button", { name: "Undo changes" }).click();
};

test("the answer of a turn that just wrote files offers to undo them", async ({
  page,
}) => {
  test.fail(true, UNDO_NOT_OFFERED);
  await writeNotes(page);
  await answerActions(page, WROTE_ANSWER).click();
  await expect(undoItem(page)).toBeVisible();
});

test("undo removes what the newest turn wrote, and the next turn is told", async ({
  page,
  request,
}) => {
  test.fail(true, UNDO_NOT_OFFERED);
  const file = await writeNotes(page);
  // From the chat as loaded, which reads the newest local turn.
  await page.reload();

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
  await expect(undoItem(page)).toHaveCount(0);
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
  test.fail(true, UNDO_NOT_OFFERED);
  const file = await writeNotes(page);
  await page.reload();
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

test("the first send of a new chat while no computer is connected says why and keeps the message", async ({
  page,
  request,
}) => {
  test.fail(
    true,
    "The API refuses the send (409 local_run_no_computer), but the new chat shows neither the reason nor the message.",
  );
  await openNewChat(page);
  await chooseRunOn(page, { place: "computer", agent: "codex", model: "text" });
  await setComputerOnline(request, false);

  await send(page, "Are you there?");

  await expect(page.getByText(NO_COMPUTER)).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect(page.getByText("Are you there?")).toBeVisible();
});

test("a send in a chat while no computer is connected says why, and goes through once it is back", async ({
  page,
  request,
  browserErrors,
}) => {
  // The browser logs the refused send, and the development build echoes its
  // failed stream read.
  browserErrors.expectCaptured(/status of 409 \(Conflict\)/u);
  browserErrors.expectCaptured(/Stream response body read failed/u);
  await openNewChat(page);
  await chooseRunOn(page, { place: "computer", agent: "codex", model: "text" });
  await send(page, "First question");
  await expect(transcript(page)).toContainText(TEXT_ANSWER, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect(page).toHaveURL(THREAD_URL);
  await setComputerOnline(request, false);

  await send(page, "Second question");

  await expect(page.getByText(NO_COMPUTER)).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });

  await setComputerOnline(request, true);
  // The refused message is offered again, in the transcript or the composer.
  if ((await composer(page).innerText()).includes("Second question")) {
    await page.getByRole("button", { name: "Send message" }).click();
  } else {
    await send(page, "Second question");
  }
  await expect(
    transcript(page).getByText(TEXT_ANSWER, { exact: true }),
  ).toHaveCount(2, { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
});

test("a computer that drops offline mid-turn picks the turn up again once it is back", async ({
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

  // Back before the run's lease lapses, as after a short network drop: the
  // computer resumes the run and the turn finishes.
  await setComputerOnline(request, false);
  await setComputerOnline(request, true);
  await expect(transcript(page)).toContainText(TEXT_ANSWER, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS * 2,
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
