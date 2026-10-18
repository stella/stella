import type { Page } from "@playwright/test";
import { EventType } from "@tanstack/ai/client";
import type { StreamChunk } from "@tanstack/ai/client";
import * as v from "valibot";

import { toSafeId } from "@stll/api-contract/safe-id";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import { dockedChatMessagePage } from "../helpers/docked-chat-history";
import {
  DOCKED_CHAT_LEGAL_ROUTES,
  installDockedLegalFixtures,
  navigatePublicLawFixture,
} from "../helpers/docked-chat-legal-fixtures";
import { EXPECTS_DEV_RUNTIME } from "../helpers/runtime-mode";
import { expect, test } from "../helpers/test";

const QUESTION = "Explain the decision in one sentence.";
const ANSWER = "The court resolved the contract claim.";
const ANSWER_ID = toSafeId<"chatMessage">(
  "019a0000-0000-7000-8000-000000000202",
);
const sendIdentitySchema = v.object({
  forwardedProps: v.object({
    threadId: v.string(),
    runId: v.string(),
    activeDecision: v.object({ decisionId: v.string() }),
    message: v.object({ role: v.literal("user") }),
  }),
});

test.use({ locale: "en-US" });

const openFreshReader = async (page: Page) => {
  await installDockedLegalFixtures(page);
  await page.route("**/v1/chat/threads/*/suggested-prompts*", async (route) => {
    await route.fulfill({ json: { prompts: [] } });
  });
  await navigatePublicLawFixture(page, DOCKED_CHAT_LEGAL_ROUTES.decision.path);
  await expect(page.locator(".reader-scroll article")).toBeVisible();
  const composer = page.locator('[data-slot="docked-chat-composer"]');
  await expect(composer.getByRole("textbox")).toBeVisible();
  return composer;
};

// HTTP fixtures exercise the real reader, fresh runtime, composer and SDK.
// Provider availability and corpus storage are outside this browser contract.
test("a fresh decision reader succeeds on its first chat question", async ({
  page,
}) => {
  let answered = false;
  let sends = 0;
  const completedMessage = {
    id: ANSWER_ID,
    role: "assistant",
    revision: 0,
    edited: false,
    createdAt: new Date().toISOString(),
    parts: [{ type: "text", content: ANSWER }],
  } satisfies (typeof dockedChatMessagePage.messages)[number];
  await page.route("**/v1/chat/threads/*/messages*", async (route) => {
    await route.fulfill({
      json: {
        ...dockedChatMessagePage,
        messages: answered ? [completedMessage] : [],
        threadExists: answered,
      },
    });
  });
  await page.route(/\/v1\/chat\/?$/u, async (route) => {
    const body: unknown = route.request().postDataJSON();
    const { forwardedProps: send } = v.parse(sendIdentitySchema, body);
    expect(send.activeDecision.decisionId).toBe(
      DOCKED_CHAT_LEGAL_ROUTES.decision.id,
    );
    sends += 1;
    answered = true;
    const events = [
      {
        type: EventType.RUN_STARTED,
        threadId: send.threadId,
        runId: send.runId,
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: ANSWER_ID,
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: ANSWER_ID,
        delta: ANSWER,
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: ANSWER_ID },
      {
        type: EventType.RUN_FINISHED,
        threadId: send.threadId,
        runId: send.runId,
      },
    ] satisfies StreamChunk[];
    await route.fulfill({
      contentType: "text/event-stream",
      body: events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  });

  const composer = await openFreshReader(page);
  await composer.getByRole("textbox").fill(QUESTION);
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator('[data-slot="docked-chat-thread"]')).toContainText(
    ANSWER,
  );
  await expect(
    page.getByRole("button", { name: "Resend", exact: true }),
  ).toHaveCount(0);
  expect(sends).toBe(1);
});

test("a fresh reader shows connection guidance when its first chat request cannot connect", async ({
  page,
  browserErrors,
}) => {
  if (EXPECTS_DEV_RUNTIME) {
    browserErrors.expectCaptured(
      /Chat connection failed|ChatRequestError|StreamReadError|Failed to fetch|connection_failed/u,
    );
  }
  browserErrors.expectCaptured(/Failed to load resource:.*ERR_FAILED/u);
  await page.route("**/v1/chat/threads/*/messages*", async (route) => {
    await route.fulfill({
      json: { ...dockedChatMessagePage, messages: [], threadExists: false },
    });
  });
  let sends = 0;
  await page.route(/\/v1\/chat\/?$/u, async (route) => {
    sends += 1;
    await route.abort("failed");
  });
  const composer = await openFreshReader(page);
  await composer.getByRole("textbox").fill(QUESTION);
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator('[data-slot="docked-chat-thread"]')).toContainText(
    messages.chat.sendErrorConnectionFailed,
  );
  await expect(
    page.getByRole("button", { name: "Resend", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-slot="docked-chat-thread"]'),
  ).not.toContainText(messages.chat.sendError);
  expect(sends).toBe(1);
});
