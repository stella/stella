import assert from "node:assert/strict";

import { EXPECTS_DEV_RUNTIME } from "../helpers/runtime-mode";
import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";

// This provider ends only through Stop, so browser work cannot exhaust the run.
const LIVE_STREAM_PROMPT = "Stream until stopped please";
const ANSWER_START = "This mock reply streams back";

test("reloading a running turn rejoins its answer without duplication", async ({
  page,
}) => {
  await page.goto("/chat", { waitUntil: "commit" });
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  await expect(composer).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await composer.fill("Summarize the notice provisions");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/chat\/[\da-f-]+$/u, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  const transcript = page.getByRole("log");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(transcript.getByRole("button", { name: "Retry" })).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect(stop).toBeHidden({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await composer.fill(LIVE_STREAM_PROMPT);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(stop).toBeVisible();
  const answer = transcript.getByText(ANSWER_START, { exact: false });
  await expect(answer).toHaveCount(1);
  await expect(answer).toBeVisible();
  // All fixture text is flushed in one batch before the provider parks.
  await expect(answer).toContainText("explicit cancellation.");
  const uninterrupted = await answer.textContent();
  assert.ok(uninterrupted !== null, "The streaming answer must contain text");
  await page.screenshot({ path: test.info().outputPath("before-reload.png") });
  const join = page.waitForResponse(
    (response) =>
      /\/turns\/[^/]+\/join/u.test(response.url()) &&
      response.request().method() === "GET",
  );
  await page.reload({ waitUntil: "commit" });
  expect((await join).ok()).toBe(true);
  await expect(answer).toHaveCount(1);
  await expect(answer).toHaveText(uninterrupted);
  await expect(stop).toBeVisible();
  await expect(stop).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("after-catchup.png") });
  await stop.click();
  await expect(stop).toBeHidden({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect(transcript).toContainText("Stopped");
  const settled = await answer.textContent();
  assert.ok(settled !== null, "The stopped answer must contain text");
  expect(settled).toBe(uninterrupted);
  await expect(transcript.getByRole("button", { name: "Resend" })).toHaveCount(
    0,
  );
  await page.reload({ waitUntil: "commit" });
  await expect(answer).toHaveCount(1);
  await expect(answer).toHaveText(settled);
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
  await expect(composer).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await composer.fill("Ask me, then answer with nothing please");
  await page.getByRole("button", { name: "Send message" }).click();
  const transcript = page.getByRole("log");
  const submit = transcript.getByRole("button", { name: "Submit answers" });
  await expect(submit).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  const threadUrl = page.url();
  await page.reload({ waitUntil: "commit" });
  await expect(submit).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect(transcript).toContainText("Which side?");
  await transcript.getByPlaceholder("Your answer").fill("Buyer");
  await submit.click();
  await expect(transcript.getByRole("button", { name: "Resend" })).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  expect(page.url()).toBe(threadUrl);
  await expect(transcript).toContainText("Buyer");
  // The answered card numbers its questions ("1. Which side?"); the question
  // must appear once, not once per delivery.
  await expect(transcript.getByText("Which side?")).toHaveCount(1);
});

test("Stop in another tab cancels a detached turn and settles both viewers", async ({
  page,
  context,
  browserErrors,
}) => {
  await page.goto("/chat", { waitUntil: "commit" });
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  await expect(composer).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await composer.fill("Summarize the notice provisions");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/chat\/[\da-f-]+$/u, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect(
    page.getByRole("log").getByRole("button", { name: "Retry" }),
  ).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  const observer = await context.newPage();
  const untrack = browserErrors.trackPage(observer);
  try {
    await observer.goto(page.url(), { waitUntil: "commit" });
    await expect(
      observer.getByRole("log").getByRole("button", { name: "Retry" }),
    ).toBeVisible({
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    // This turn ends only through cancellation, so reload cannot race a
    // finite mock reply finishing and morphing Stop into disabled Send.
    await composer.fill(LIVE_STREAM_PROMPT);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByRole("log").getByText(ANSWER_START, { exact: false }),
    ).toBeVisible();
    const joins = [page, observer].map(async (viewer) =>
      viewer.waitForResponse(
        (response) =>
          /\/turns\/[^/]+\/join/u.test(response.url()) &&
          response.request().method() === "GET",
      ),
    );
    await Promise.all([
      page.reload({ waitUntil: "commit" }),
      observer.reload({ waitUntil: "commit" }),
    ]);
    for (const join of joins) {
      expect((await join).ok()).toBe(true);
    }
    const stop = observer.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible({
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    await expect(stop).toBeEnabled();
    await stop.click();
    await expect(stop).toBeHidden({
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeHidden({
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
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
