import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { panic } from "better-result";
import * as v from "valibot";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import { apiDelete, apiGet } from "../helpers/api";
import { JOURNEY_TAG } from "../playwright.journeys.config";

const TURN_FILLER = "Clause ".repeat(25_000);
const MAX_TURNS = 16;
// Allow the five-minute background compactor cadence and its one-minute run budget.
const COMPACTION_SETTLE_MS = 6 * 60_000;
// One mock-model turn, from send to its persisted reply.
const TURN_SETTLE_MS = 2 * 60_000;
const CHAT_THREAD_PATH = /\/chat\/([0-9a-f-]{36})$/u;

const threadSchema = v.object({
  activeTurnId: v.nullable(v.string()),
  context: v.object({
    estimatedTokens: v.number(),
    triggerTokens: v.number(),
    summarizedMessageCount: v.number(),
    breakdown: v.object({ summaryTokens: v.number() }),
  }),
  messages: v.array(
    v.object({
      role: v.string(),
      metadata: v.optional(
        v.nullable(v.looseObject({ contextNotice: v.optional(v.unknown()) })),
      ),
    }),
  ),
});

type ChatThread = v.InferOutput<typeof threadSchema>;

const readThread = async (
  request: APIRequestContext,
  threadId: string,
): Promise<ChatThread> =>
  v.parse(
    threadSchema,
    await apiGet(request, `/chat/threads/${threadId}/messages`),
  );

const assistantMessages = (thread: ChatThread) =>
  thread.messages.filter(({ role }) => role === "assistant");

const currentThreadId = (page: Page): string =>
  CHAT_THREAD_PATH.exec(new URL(page.url()).pathname)?.at(1) ??
  panic(`The chat did not open a thread: ${page.url()}`);

const SUGGESTED_PROMPT_LABEL = messages.chat.tabToAsk.split("{prompt}").at(0);

const chatComposer = (page: Page) =>
  page
    .getByRole("textbox", { exact: true, name: messages.chat.placeholder })
    .or(
      page.getByRole("textbox", {
        name:
          SUGGESTED_PROMPT_LABEL ?? panic("chat.tabToAsk has no prompt slot"),
      }),
    );

type SendTurnOptions = {
  page: Page;
  request: APIRequestContext;
  turn: number;
};

const sendTurn = async ({
  page,
  request,
  turn,
}: SendTurnOptions): Promise<ChatThread> => {
  await chatComposer(page).fill(`Journey turn ${String(turn)}. ${TURN_FILLER}`);
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/v1/chat"),
    { timeout: TURN_SETTLE_MS },
  );
  await page.getByRole("button", { name: messages.chat.sendPrompt }).click();
  const response = await posted;
  expect(response.ok()).toBe(true);
  await expect(page).toHaveURL(CHAT_THREAD_PATH);
  const threadId = currentThreadId(page);
  // The streamed response is not the turn's end signal: the browser need not
  // report its body finished. The thread does: no active turn, this reply kept.
  await expect
    .poll(
      async () => {
        const thread = await readThread(request, threadId);
        return {
          activeTurnId: thread.activeTurnId,
          assistantReplies: assistantMessages(thread).length,
        };
      },
      { timeout: TURN_SETTLE_MS },
    )
    .toEqual({ activeTurnId: null, assistantReplies: turn });
  return await readThread(request, threadId);
};

const expectNoTrimmedHistory = async (page: Page, thread: ChatThread) => {
  expect(
    assistantMessages(thread).filter(
      ({ metadata }) =>
        metadata?.contextNotice !== undefined &&
        metadata.contextNotice !== null,
    ),
  ).toEqual([]);
  await expect(
    page.getByRole("log").getByText(messages.chat.historyTrimmed),
  ).toHaveCount(0);
};

test.afterEach(async ({ page, request }) => {
  const threadId = CHAT_THREAD_PATH.exec(new URL(page.url()).pathname)?.at(1);
  if (threadId !== undefined) {
    await apiDelete(request, `/chat/threads/${threadId}`);
  }
});

test(
  "compaction replaces history and survives reload; unchanged history without a trimming notice fails",
  { tag: JOURNEY_TAG.localStack },
  async ({ page, request }) => {
    test.setTimeout(11 * 60_000);
    await page.goto("/chat/new", { waitUntil: "commit" });
    await expect(chatComposer(page)).toBeVisible({ timeout: 60_000 });

    let turn = 1;
    let thread = await sendTurn({ page, request, turn });
    while (thread.context.estimatedTokens <= thread.context.triggerTokens) {
      turn += 1;
      if (turn > MAX_TURNS) {
        panic(
          `The chat stayed under its compaction trigger after ${String(MAX_TURNS)} turns`,
        );
      }
      thread = await sendTurn({ page, request, turn });
    }
    await sendTurn({ page, request, turn: turn + 1 });
    // Sends enqueue durable compaction; they do not wait for the scheduler.
    // Observe the same checkpoint-derived context the page loads.
    const threadId = currentThreadId(page);
    await expect
      .poll(
        async () =>
          (await readThread(request, threadId)).context.summarizedMessageCount,
        { intervals: [10_000], timeout: COMPACTION_SETTLE_MS },
      )
      .toBeGreaterThan(0);
    thread = await readThread(request, threadId);
    expect(thread.context.summarizedMessageCount).toBeGreaterThan(0);
    expect(thread.context.breakdown.summaryTokens).toBeGreaterThan(0);
    await expectNoTrimmedHistory(page, thread);

    const reloadedMessages = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          `/v1/chat/threads/${currentThreadId(page)}/messages`,
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const reloadedResponse = await reloadedMessages;
    expect(reloadedResponse.ok()).toBe(true);
    const reloadedThread = v.parse(threadSchema, await reloadedResponse.json());
    expect(
      reloadedThread.context.summarizedMessageCount,
    ).toBeGreaterThanOrEqual(thread.context.summarizedMessageCount);
    expect(reloadedThread.context.breakdown.summaryTokens).toBeGreaterThan(0);
    await expect(page.getByRole("log")).toBeVisible({ timeout: 60_000 });
    await expectNoTrimmedHistory(page, reloadedThread);
  },
);
