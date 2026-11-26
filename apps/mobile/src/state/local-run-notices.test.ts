import { describe, expect, test } from "bun:test";

import {
  CHAT_LOCAL_RUN_NOTICES_METADATA_KEY,
  type ChatLocalRunNotice,
} from "@stll/api-contract/chat-local-run-notice";

import { toChatEntry } from "@/state/chat-messages";
import {
  answerEntry,
  applyChatEvent,
  type ChatEvent,
  EMPTY_ANSWER,
  parseChatEvent,
  type StreamedAnswer,
} from "@/state/chat-stream";
import {
  localRunNoticeLine,
  localRunNoticeLines,
} from "@/state/local-run-notices";

const ANSWER_ID = "answer-1";
const CREATED_AT = "2026-11-25T10:00:00.000Z";

/** The stream restating every notice of the answer, as the API does. */
const restated = (...notices: ChatLocalRunNotice[]) => ({
  type: "TEXT_MESSAGE_START",
  messageId: ANSWER_ID,
  role: "assistant",
  metadata: { [CHAT_LOCAL_RUN_NOTICES_METADATA_KEY]: notices },
});

const reduce = (events: readonly unknown[]): StreamedAnswer => {
  let answer = EMPTY_ANSWER;
  for (const event of events.flatMap((each): ChatEvent[] => {
    const parsed = parseChatEvent(JSON.stringify(each));
    return parsed === undefined ? [] : [parsed];
  })) {
    answer = applyChatEvent(answer, event);
  }
  return answer;
};

const answering = [
  { type: "RUN_STARTED", runId: "run-1", threadId: "thread-1" },
  { type: "TEXT_MESSAGE_START", messageId: ANSWER_ID, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: ANSWER_ID, delta: "Done." },
  { type: "TEXT_MESSAGE_END", messageId: ANSWER_ID },
];

const warning = { kind: "config_warning" } as const;
const retrying = {
  kind: "retrying",
  status: "retrying",
  attempt: 2,
  maxAttempts: 5,
} as const satisfies ChatLocalRunNotice;
const recovered = { ...retrying, status: "recovered" } as const;

describe("what the run on the person's computer said about itself", () => {
  test("follows the stream's last restatement without adding to the answer's text", () => {
    const plain = reduce(answering);
    const live = reduce([
      ...answering.slice(0, 1),
      restated(warning, retrying),
      ...answering.slice(1),
    ]);
    expect(live.localRunNotices).toEqual([warning, retrying]);
    expect(live.parts).toEqual(plain.parts);

    const settled = reduce([
      ...answering.slice(0, 1),
      restated(warning, retrying),
      ...answering.slice(1),
      restated(warning, recovered),
    ]);
    expect(answerEntry(settled, CREATED_AT).localRunNotices).toEqual([
      warning,
      recovered,
    ]);
    expect(answerEntry(plain, CREATED_AT).localRunNotices).toBeUndefined();
  });

  test("a reloaded answer shows the notices the live one showed", () => {
    const live = answerEntry(
      reduce([...answering, restated(warning, recovered)]),
      CREATED_AT,
    );
    const stored = toChatEntry({
      id: ANSWER_ID,
      role: "assistant",
      createdAt: CREATED_AT,
      parts: [{ type: "text", content: "Done." }],
      metadata: { [CHAT_LOCAL_RUN_NOTICES_METADATA_KEY]: [warning, recovered] },
    });
    expect(stored?.localRunNotices).toEqual(live.localRunNotices);
  });

  test("a retry that ended with its turn shows nothing, live or stored", () => {
    const ended = { ...retrying, status: "ended" } as const;
    expect(
      answerEntry(reduce([...answering, restated(ended)]), CREATED_AT)
        .localRunNotices,
    ).toBeUndefined();
    expect(
      toChatEntry({
        id: ANSWER_ID,
        role: "assistant",
        createdAt: CREATED_AT,
        parts: [{ type: "text", content: "Done." }],
        metadata: { [CHAT_LOCAL_RUN_NOTICES_METADATA_KEY]: [ended] },
      })?.localRunNotices,
    ).toBeUndefined();
  });

  test("reads each notice as the web's message, with the retry's count only when the harness gave both", () => {
    const notices: readonly ChatLocalRunNotice[] = [
      retrying,
      { ...retrying, maxAttempts: null },
      recovered,
      warning,
      { kind: "capability_unavailable", capability: "browser" },
      { ...retrying, status: "ended" },
    ];
    expect(notices.map((notice) => localRunNoticeLine(notice))).toEqual([
      {
        id: "retrying",
        message: "localRun.notices.retryingAttempt",
        values: { attempt: 2, maxAttempts: 5 },
      },
      { id: "retrying", message: "localRun.notices.retrying" },
      { id: "retrying", message: "localRun.notices.recovered" },
      { id: "config_warning", message: "localRun.notices.configWarning" },
      {
        id: "capability_unavailable:browser",
        message: "localRun.notices.browserUnavailable",
      },
      null,
    ]);
  });

  test("an answer no longer arriving reads a retry still under way as ended", () => {
    expect(
      localRunNoticeLines([warning, retrying], true).map(
        ({ message }) => message,
      ),
    ).toEqual([
      "localRun.notices.configWarning",
      "localRun.notices.retryingAttempt",
    ]);
    expect(
      localRunNoticeLines([warning, retrying], false).map(
        ({ message }) => message,
      ),
    ).toEqual(["localRun.notices.configWarning"]);
  });
});
