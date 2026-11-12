import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  CHAT_TOOL_LABELS,
  UNKNOWN_CHAT_TOOL_LABEL,
} from "@stll/api-contract/chat-tool-activity";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import type { AnswerBlock } from "./chat-answer";
import { readChatThread } from "./chat-messages";
import type { ChatEntry } from "./chat-messages";
import {
  answerEntry,
  applyChatEvent,
  createSseParser,
  EMPTY_ANSWER,
  parseChatEvent,
} from "./chat-stream";

// Conversations the web app's chat recorded against the real send pipeline
// (`apps/api/src/tests/helpers/recorded-conversations.ts`): for each request,
// the stream the server answered with and the thread's stored page after it.
// The phone reads both, so what it draws is checked against what the server
// really sends and stores, never against hand-built messages.
const RECORDED = path.resolve(
  import.meta.dir,
  "../../../web/src/components/chat/__fixtures__/recorded-conversations",
);

const recordingSchema = v.object({
  scenario: v.string(),
  steps: v.array(
    v.object({
      exchanges: v.array(
        v.object({
          ended: v.string(),
          page: v.unknown(),
          request: v.looseObject({
            forwardedProps: v.optional(
              v.looseObject({
                message: v.optional(v.looseObject({ role: v.string() })),
              }),
            ),
          }),
          response: v.object({ body: v.string() }),
        }),
      ),
    }),
  ),
});

const recordings = readdirSync(RECORDED)
  .filter((name) => name.endsWith(".gen.json"))
  .toSorted()
  .map((name) =>
    v.parse(
      recordingSchema,
      JSON.parse(readFileSync(path.join(RECORDED, name), "utf-8")),
    ),
  );

const exchanges = recordings.flatMap(({ scenario, steps }) =>
  steps.flatMap(({ exchanges: recorded }) =>
    recorded.map((exchange) => ({ scenario, ...exchange })),
  ),
);

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  signInId: "sign-in-1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

/** The thread as the phone reads it, from a stored page the server sent. */
const storedEntries = async (page: unknown): Promise<readonly ChatEntry[]> => {
  const fetch: Fetch = async () => Response.json(page);
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  const source = createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store,
    generation: store.generation(),
  });
  const read = await readChatThread({
    fetch,
    matterId: undefined,
    source,
    threadId: "thread",
  });
  return read.isOk() ? read.value.entries : [];
};

/** The answer as the phone draws it while it streams, from the whole body. */
const streamedEntry = (body: string): ChatEntry => {
  let answer = EMPTY_ANSWER;
  for (const event of createSseParser()(body)) {
    const parsed = parseChatEvent(event.data);
    if (parsed !== undefined) {
      answer = applyChatEvent(answer, parsed);
    }
  }
  return answerEntry(answer, "2026-01-01T00:00:00.000Z");
};

/** What a person sees of an answer's blocks; a run's place is not drawn. */
const drawn = (blocks: readonly AnswerBlock[]) =>
  blocks.map((block) =>
    block.type === "text"
      ? { text: block.markdown }
      : { steps: block.steps, work: block.work },
  );

describe("recorded conversations on the phone", () => {
  test("reads every recording", () => {
    expect(exchanges.length).toBeGreaterThan(20);
    expect(
      exchanges.some(
        ({ scenario }) => scenario === "code-mode-refs-after-answer",
      ),
    ).toBe(true);
  });

  test("titles every step of a stored answer, never by a stella tool's own name", async () => {
    let titled = 0;
    for (const { page, scenario } of exchanges) {
      const labels = (await storedEntries(page))
        .flatMap((entry) => entry.blocks)
        .flatMap((block) => (block.type === "steps" ? block.steps : []))
        .flatMap((step) => (step.type === "tool" ? [step.label] : []));
      titled += labels.length;
      for (const label of labels) {
        expect({ scenario, label: CHAT_TOOL_LABELS.includes(label) }).toEqual({
          scenario,
          label: true,
        });
      }
      // Only a connector's own tool, which stella cannot name, reads as a
      // generic step.
      if (!JSON.stringify(page).includes('"name":"mcp__')) {
        expect({ scenario, labels }).toEqual({
          scenario,
          labels: labels.filter((label) => label !== UNKNOWN_CHAT_TOOL_LABEL),
        });
      }
    }
    expect(titled).toBeGreaterThan(0);
  });

  test("sums up code mode's runs as the web does", async () => {
    const answered = exchanges.find(
      ({ scenario }) => scenario === "code-mode-refs-after-answer",
    );
    const [, answer] = await storedEntries(answered?.page);
    expect(drawn(answer?.blocks ?? [])).toEqual([
      {
        steps: [{ type: "tool", label: "execute_typescript", status: "done" }],
        work: new Map([["computation", 1]]),
      },
      { text: "Two documents" },
    ]);
  });

  test("draws an answer the same while it streams as once it is stored", async () => {
    const sent = exchanges.filter(
      ({ ended, request }) =>
        ended === "complete" &&
        request.forwardedProps?.message?.role === "user",
    );
    expect(sent.length).toBeGreaterThan(10);
    for (const { page, response, scenario } of sent) {
      const live = streamedEntry(response.body);
      const stored = (await storedEntries(page)).find(
        (entry) => entry.id === live.id,
      );
      if (stored === undefined) {
        // An answer with nothing to draw is not stored as a message.
        expect({ scenario, blocks: live.blocks }).toEqual({
          scenario,
          blocks: [],
        });
        continue;
      }
      expect({ scenario, blocks: drawn(live.blocks) }).toEqual({
        scenario,
        blocks: drawn(stored.blocks),
      });
    }
  });
});
