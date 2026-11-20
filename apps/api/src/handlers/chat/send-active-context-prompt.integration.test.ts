import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import * as v from "valibot";

import { ACTIVE_CONTEXT_SCHEMAS } from "@/api/handlers/chat/chat-schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type ChatSendActiveField,
  type ChatSendScope,
  createFirstSendHarness,
  type FirstSendHarness,
  PICKABLE_CHAT_MODELS,
} from "@/api/tests/helpers/chat-first-send";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

// Request to prompt, for every field of the send request that carries an
// open document or skill: the field reaches the system prompt the send
// builds, through the real send path and database. The case table is keyed by
// the contract's `active*` keys, so a new field is a type error here until it
// has a case, and the first test holds the table equal to the server schema's
// fields at runtime.

let harness: FirstSendHarness;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  harness = await createFirstSendHarness({
    ids: fixture.ids,
    testDb: fixture.testDb,
  });
});

afterEach(async () => {
  await harness.resetThreads();
});

afterAll(async () => {
  await harness.dispose();
  await releaseRlsFixture();
});

/** The scope a chat showing each kind of context runs in. */
const ACTIVE_FIELD_SCOPE = {
  activeDecision: "global",
  activeDraft: "global",
  activeExternal: "global",
  // A file is opened inside its matter.
  activeFile: "workspace",
  activeSkill: "global",
  activeStatute: "global",
  activeTemplate: "global",
} as const satisfies Record<ChatSendActiveField, ChatSendScope>;

const isActiveField = (key: string): key is ChatSendActiveField =>
  Object.hasOwn(ACTIVE_FIELD_SCOPE, key);

const ACTIVE_FIELDS = Object.keys(ACTIVE_FIELD_SCOPE)
  .filter(isActiveField)
  .toSorted();

/** How the thread a first send lands on came to exist. */
const THREAD_ORIGINS: [
  string,
  (scope: ChatSendScope) => Promise<SafeId<"chatThread">>,
][] = [
  ["a new thread", async () => harness.newDraftThreadId()],
  [
    "a thread a model pick created",
    async (scope) => {
      const threadId = harness.newDraftThreadId();
      expect(
        await harness.setModel({
          model: PICKABLE_CHAT_MODELS[1],
          scope,
          threadId,
        }),
      ).toMatchObject({ ok: true });
      return threadId;
    },
  ],
  [
    "a thread a web-search toggle created",
    async (scope) => {
      const threadId = harness.newDraftThreadId();
      expect(
        await harness.setWebSearch({ enabled: true, scope, threadId }),
      ).toMatchObject({ ok: true });
      return threadId;
    },
  ],
];

describe("every active field of a send reaches the system prompt", () => {
  test("the case table covers exactly the server schema's active fields", () => {
    const declared: readonly string[] = ACTIVE_FIELDS;
    expect(declared).toEqual(Object.keys(ACTIVE_CONTEXT_SCHEMAS).toSorted());
    for (const field of ACTIVE_FIELDS) {
      // Each fixture is a value the route accepts on the wire.
      expect(
        v.safeParse(ACTIVE_CONTEXT_SCHEMAS[field], harness.activeValues[field])
          .success,
      ).toBe(true);
    }
  });

  test("a send carrying no active field shows none of their sections", async () => {
    for (const scope of ["global", "workspace"] as const) {
      const { outcome, systemPrompt } = await harness.send({
        carried: {},
        scope,
        threadId: harness.newDraftThreadId(),
      });
      expect(outcome).toMatchObject({ ok: true });
      expect(systemPrompt).toBeString();
      for (const field of ACTIVE_FIELDS) {
        expect(systemPrompt).not.toContain(harness.promptMarkers[field]);
      }
    }
  });

  describe.each(THREAD_ORIGINS)("on %s", (_origin, openThread) => {
    test.each(ACTIVE_FIELDS)("%s", async (field) => {
      const scope = ACTIVE_FIELD_SCOPE[field];
      const threadId = await openThread(scope);

      const { outcome, systemPrompt } = await harness.send({
        carried: harness.carryingOnly[field],
        scope,
        threadId,
      });

      expect(outcome).toMatchObject({ ok: true });
      expect(systemPrompt).toContain(harness.promptMarkers[field]);
    });
  });
});
