import assert from "node:assert/strict";

import { EXPECTS_DEV_RUNTIME } from "../helpers/runtime-mode";
import { expect, test } from "../helpers/test";

// The installed mock provider holds this reply open at word boundaries.
const SLOW_STREAM_PROMPT = "Stream slowly please";
const ANSWER_START = "This mock reply streams back";

test("reloading a running turn rejoins its answer without duplication", async ({
  page,
}) => {
  await page.goto("/chat", { waitUntil: "commit" });
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(SLOW_STREAM_PROMPT);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/chat\/[\da-f-]+$/u, { timeout: 30_000 });
  const transcript = page.getByRole("log");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(transcript.getByRole("button", { name: "Retry" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(stop).toBeHidden({ timeout: 30_000 });
  const answer = transcript.getByText(ANSWER_START, { exact: false });
  await expect(answer).toBeVisible();
  const uninterrupted = await answer.textContent();
  assert.ok(uninterrupted !== null, "The completed answer must contain text");

  await composer.fill(SLOW_STREAM_PROMPT);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(stop).toBeVisible();
  await expect(answer).toHaveCount(2);
  const partial = await answer.last().textContent();
  assert.ok(partial !== null, "The streaming answer must contain text");
  expect(partial.length).toBeLessThan(uninterrupted.length);
  await page.screenshot({ path: test.info().outputPath("before-reload.png") });
  const join = page.waitForResponse(
    (response) =>
      /\/turns\/[^/]+\/join/u.test(response.url()) &&
      response.request().method() === "GET",
  );
  await page.reload({ waitUntil: "commit" });
  expect((await join).ok()).toBe(true);
  await expect(answer).toHaveCount(2);
  await expect(answer.last()).toHaveText(uninterrupted, { timeout: 30_000 });
  await page.screenshot({ path: test.info().outputPath("after-catchup.png") });
  await expect(stop).toBeHidden({ timeout: 30_000 });
  await expect(transcript.getByRole("button", { name: "Resend" })).toHaveCount(
    0,
  );
  await page.reload({ waitUntil: "commit" });
  await expect(answer).toHaveCount(2);
  await expect(answer.last()).toHaveText(uninterrupted);
});

test("a pending question survives reload and continues its original turn", async ({
  page,
  browserErrors,
}) => {
  if (EXPECTS_DEV_RUNTIME) {
    browserErrors.expectCaptured(/empty_completion/u);
  }
  await page.goto("/chat", { waitUntil: "commit" });
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill("Ask me, then answer with nothing please");
  await page.getByRole("button", { name: "Send message" }).click();
  const transcript = page.getByRole("log");
  const submit = transcript.getByRole("button", { name: "Submit answers" });
  await expect(submit).toBeVisible({ timeout: 30_000 });
  const threadUrl = page.url();
  await page.reload({ waitUntil: "commit" });
  await expect(submit).toBeVisible({ timeout: 30_000 });
  await expect(transcript).toContainText("Which side?");
  await transcript.getByPlaceholder("Your answer").fill("Buyer");
  await submit.click();
  await expect(transcript.getByRole("button", { name: "Resend" })).toBeVisible({
    timeout: 30_000,
  });
  expect(page.url()).toBe(threadUrl);
  await expect(transcript).toContainText("Buyer");
  await expect(
    transcript.getByText("Which side?", { exact: true }),
  ).toHaveCount(1);
});

test("Stop in another tab cancels a detached turn and settles both viewers", async ({
  page,
  context,
  browserErrors,
}) => {
  await page.goto("/chat", { waitUntil: "commit" });
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill("Summarize the notice provisions");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/chat\/[\da-f-]+$/u, { timeout: 30_000 });
  await expect(
    page.getByRole("log").getByRole("button", { name: "Retry" }),
  ).toBeVisible({
    timeout: 30_000,
  });
  const observer = await context.newPage();
  const untrack = browserErrors.trackPage(observer);
  try {
    await observer.goto(page.url(), { waitUntil: "commit" });
    await expect(
      observer.getByRole("log").getByRole("button", { name: "Retry" }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await composer.fill(SLOW_STREAM_PROMPT);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByRole("log").getByText(ANSWER_START, { exact: false }),
    ).toBeVisible();
    await page.reload({ waitUntil: "commit" });
    await observer.reload({ waitUntil: "commit" });
    const stop = observer.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await stop.click();
    await expect(stop).toBeHidden({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeHidden({
      timeout: 30_000,
    });
    await expect(observer.getByRole("log")).toContainText("Stopped");
    await expect(page.getByRole("log")).toContainText("Stopped");
    const stoppedText = await observer
      .getByRole("log")
      .getByText(ANSWER_START, { exact: false })
      .textContent();
    assert.ok(stoppedText !== null, "The stopped answer must contain text");
    await page.reload({ waitUntil: "commit" });
    await expect(
      page.getByRole("log").getByText(ANSWER_START, { exact: false }),
    ).toHaveText(stoppedText);
  } finally {
    untrack();
    await observer.close();
  }
});
