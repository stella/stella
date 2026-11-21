import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { existsSync } from "node:fs";

import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";
import {
  agentLog,
  chooseRunOn,
  expectComputerState,
  expectRunOn,
  expectTurnsFinished,
  filesWritten,
  messagesReceived,
  openNewChat,
  relinkComputer,
  send,
  setComputerOnline,
  THREAD_URL,
  transcript,
} from "./computer";

// Turns whose computer goes away, links again, or whose edit undoes what the
// turns since wrote.

const TEXT_ANSWER =
  "Lease one is the office lease; lease two is the warehouse.";
/** `writes_file` adds notes.md to the run's folder, then answers this. */
const WROTE_ANSWER = "Wrote notes.md.";
/** What the next turn tells the agent after an undo (control.ts). */
const UNDONE_NOTE = "the member undid the file changes of an earlier reply";
const UNDO_REQUEST =
  /\/chat\/threads\/[^/]+\/messages\/[^/]+\/local-files\/undo$/u;
/** The edit form's choice to undo the files too. */
const UNDO_FILES = "Also undo file changes made since this message";

/** The chat's read of its thread. */
const THREAD_MESSAGES = /\/v1\/chat\/threads\/[^/]+\/messages(?:\?|$)/u;
/** Why a turn failed while none of the member's computers was connected. */
const NO_COMPUTER = "None of your computers is connected.";
/** The failed turn's button that opens stella desktop and sends again. */
const OPEN_DESKTOP = "Open stella desktop";
/** What a turn, and that button, say while stella desktop opens. */
const OPENING_DESKTOP = "Opening stella desktop…";

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
  await expectTurnsFinished(page, 1);
  const written = filesWritten(log);
  expect(written).toHaveLength(1);
  const [file = ""] = written;
  expect(existsSync(file), `${file} is on the computer`).toBe(true);
  return file;
};

/** Open the edit form of the member's message that asked for the notes. */
const editNotesMessage = async (page: Page) => {
  const message = transcript(page)
    .locator("[data-chat-message-id]")
    .filter({ hasText: "Write the notes" });
  await message.hover();
  await message.getByRole("button", { name: "Edit message" }).click();
  const form = page.locator("[data-chat-message-edit]");
  await expect(form).toBeVisible();
  return form;
};

/** Replace the edited text and send it from the form. */
const sendEdit = async (form: Locator, text: string) => {
  const input = form.getByRole("textbox", { name: "Edited message" });
  await input.focus();
  await input.press("ControlOrMeta+a");
  await input.pressSequentially(text);
  await form.getByRole("button", { name: "Send message" }).click();
};

test("editing the message that wrote files offers to undo them, unchecked", async ({
  page,
}) => {
  await writeNotes(page);
  const form = await editNotesMessage(page);
  const choice = form.getByRole("checkbox", { name: UNDO_FILES });
  await expect(choice).toBeEnabled({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect(choice).not.toBeChecked();
  await expect(form).toContainText(
    "This also undoes changes you made in the folder yourself.",
  );
});

test("an edit that undoes the files removes what the turns since wrote, and the edited turn is told", async ({
  page,
}) => {
  const file = await writeNotes(page);
  // From the chat as loaded.
  await page.reload({ waitUntil: "commit" });
  await expectTurnsFinished(page, 1);
  await chooseRunOn(page, { place: "computer", agent: "codex", model: "text" });

  const log = agentLog("codex");
  const form = await editNotesMessage(page);
  const choice = form.getByRole("checkbox", { name: UNDO_FILES });
  await expect(choice).toBeEnabled({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await choice.check();
  const undoRequest = page.waitForRequest(
    (sent) => sent.method() === "POST" && UNDO_REQUEST.test(sent.url()),
    { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
  );
  await sendEdit(form, "What is in the folder now?");
  await undoRequest;

  await expect(transcript(page)).toContainText(TEXT_ANSWER, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect(form).toHaveCount(0);
  expect(existsSync(file)).toBe(false);
  // The edited turn carries the note, so the agent reads files again.
  expect(
    messagesReceived(log).some((message) => message.includes(UNDONE_NOTE)),
  ).toBe(true);
  await expect(transcript(page)).not.toContainText(WROTE_ANSWER);
});

test("an undo refused while the computer is offline sends nothing and keeps the file", async ({
  page,
  request,
  browserErrors,
}) => {
  // The browser logs the refused undo.
  browserErrors.expectCaptured(/status of 409 \(Conflict\)/u);
  const file = await writeNotes(page);
  await page.reload({ waitUntil: "commit" });
  await expectTurnsFinished(page, 1);
  const form = await editNotesMessage(page);
  const choice = form.getByRole("checkbox", { name: UNDO_FILES });
  await expect(choice).toBeEnabled({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await choice.check();
  await setComputerOnline(request, false);

  await sendEdit(form, "What is in the folder now?");

  await expect(form).toContainText(
    "Your computer is offline. Open the stella desktop app and try again.",
    { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
  );
  // The draft stays, the box unchecked, and the turn is not replaced.
  await expect(
    form.getByRole("textbox", { name: "Edited message" }),
  ).toHaveText("What is in the folder now?");
  await expect(choice).not.toBeChecked();
  await expect(transcript(page)).toContainText(WROTE_ANSWER);
  expect(existsSync(file)).toBe(true);
});

test("the first send of a new chat while no computer is connected says why and keeps the message", async ({
  page,
  request,
}) => {
  await openNewChat(page);
  await chooseRunOn(page, { place: "computer", agent: "codex", model: "text" });
  await setComputerOnline(request, false);

  const threadRead = page.waitForResponse(
    (response) => THREAD_MESSAGES.test(response.url()),
    { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
  );
  await send(page, "Are you there?");

  await expect(transcript(page).getByText(NO_COMPUTER)).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  // After the new chat has read its thread, so a message shown only until
  // then does not count as kept.
  await threadRead;
  // And after the page has drawn what it read.
  await page.evaluate(
    async () =>
      await new Promise<null>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(null);
          });
        });
      }),
  );
  expect(await transcript(page).textContent()).toContain("Are you there?");
});

/** A chat on the computer with one answered turn. */
const answeredChat = async (page: Page) => {
  await openNewChat(page);
  await chooseRunOn(page, { place: "computer", agent: "codex", model: "text" });
  await send(page, "First question");
  await expect(transcript(page)).toContainText(TEXT_ANSWER, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect(page).toHaveURL(THREAD_URL);
  await expectTurnsFinished(page, 1);
};

const answers = (page: Page) =>
  transcript(page).getByText(TEXT_ANSWER, { exact: true });

/**
 * A chat whose latest turn just failed: the page had last read the computer
 * as connected, so the send went out, the API stored it, and its run found
 * no computer to start on.
 */
const failedSend = async (page: Page, request: APIRequestContext) => {
  await answeredChat(page);
  await setComputerOnline(request, false);
  await send(page, "Second question");
  await expect(transcript(page).getByText(NO_COMPUTER)).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
};

test("a send while no computer is connected is stored and fails with the reason, also after a reload, and offers to open stella desktop", async ({
  page,
  request,
}) => {
  await failedSend(page, request);

  await expect(transcript(page)).toContainText("Second question");
  await expect(
    transcript(page).getByRole("button", { name: OPEN_DESKTOP }),
  ).toBeEnabled();
  await expect(
    transcript(page).getByRole("button", { name: "Resend" }),
  ).toBeEnabled();
  await expect(answers(page)).toHaveCount(1);

  // The server holds the message and why its turn failed: a reload shows
  // both, read from the stored thread.
  await page.reload({ waitUntil: "commit" });
  await expect(transcript(page)).toContainText("Second question", {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect(transcript(page).getByText(NO_COMPUTER)).toBeVisible();
  await expect(answers(page)).toHaveCount(1);
});

test("Open stella desktop on a turn that failed with no computer sends it again once a computer is back", async ({
  page,
  request,
}) => {
  await failedSend(page, request);

  await transcript(page).getByRole("button", { name: OPEN_DESKTOP }).click();
  // The launch waits for a computer, and says so in the button's place.
  await expect(
    transcript(page).getByRole("button", { name: OPENING_DESKTOP }),
  ).toBeDisabled();

  await setComputerOnline(request, true);

  // Sent again without another click.
  await expect(answers(page)).toHaveCount(2, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect(transcript(page).getByText(NO_COMPUTER)).toHaveCount(0);
});

test("a send while the chat shows the computer offline waits for stella desktop, and goes out once the computer is back", async ({
  page,
  request,
}) => {
  await answeredChat(page);
  await setComputerOnline(request, false);
  // The chat as loaded reads the computer again and says it is offline.
  await page.reload({ waitUntil: "commit" });
  await expectComputerState(page, "codex", "offline");

  await send(page, "Second question");

  await expect(
    transcript(page).getByRole("status").filter({ hasText: OPENING_DESKTOP }),
  ).toBeVisible();
  await expectComputerState(page, "codex", "openingDesktop");
  await expect(answers(page)).toHaveCount(1);

  await setComputerOnline(request, true);

  await expect(answers(page)).toHaveCount(2, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expectRunOn(page, { place: "computer", agent: "codex", model: "text" });
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
