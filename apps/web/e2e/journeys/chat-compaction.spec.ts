import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { panic } from "better-result";
import * as v from "valibot";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import { apiDelete, apiGet } from "../helpers/api";
import { JOURNEY_TAG } from "../playwright.journeys.config";

const TURN_FILLER = "Clause ".repeat(25_000);
const MAX_TURNS = 16;
const CHAT_THREAD_PATH = /\/chat\/([0-9a-f-]{36})$/u;

const threadSchema = v.object({
  activeTurnId: v.nullable(v.string()),
  context: v.object({
    estimatedTokens: v.number(),
    triggerTokens: v.number(),
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
  );
  await page.getByRole("button", { name: messages.chat.sendPrompt }).click();
  expect((await posted).ok()).toBe(true);
  await expect(page).toHaveURL(CHAT_THREAD_PATH);
  const threadId = currentThreadId(page);
  await expect
    .poll(async () => {
      const thread = await readThread(request, threadId);
      return {
        activeTurnId: thread.activeTurnId,
        answers: assistantMessages(thread).length,
      };
    })
    .toEqual({ activeTurnId: null, answers: turn });
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

test(
  "a chat past the compaction trigger keeps summarizing its history",
  { tag: JOURNEY_TAG.localStack },
  async ({ page, request }) => {
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
    thread = await sendTurn({ page, request, turn: turn + 1 });
    await expectNoTrimmedHistory(page, thread);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("log")).toBeVisible({ timeout: 60_000 });
    await expectNoTrimmedHistory(page, thread);

    await apiDelete(request, `/chat/threads/${currentThreadId(page)}`);
  },
);
