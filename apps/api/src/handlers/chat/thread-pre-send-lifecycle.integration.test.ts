import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { listSkillMetadata } from "@stll/skills";

import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import { CHAT_SEND_CONTEXT_IGNORED_EVENT } from "@/api/handlers/chat/send-thread-fields";
import type { SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import {
  type CarriedSendContext,
  type ChatSendScope,
  createFirstSendHarness,
  type FirstSendHarness,
  PICKABLE_CHAT_MODELS,
} from "@/api/tests/helpers/chat-first-send";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";

// A chat thread's life before its first message, against the real handlers
// and database: any sequence of the writes and reads that can create or touch
// the thread row before a message exists, then a first send carrying any mix
// of the context a new thread is created with, then a later send.
//
// Routes that create a `chatThreads` row (every `insert(chatThreads)` site):
//   update-thread-model.ts   PATCH model: upserts a placeholder (PickModel)
//   threads/update.ts        PATCH web search: upserts a placeholder
//                            (ToggleWebSearch)
//   file-thread-shared.ts    resolve-file-thread: creates a file chat or
//                            adopts a draft id (origin "file", AdoptFileChat)
//   template-thread-shared   resolve/rotate-template-thread: creates a
//                            template chat (origin "template")
//   send-message-thread.ts   the first send itself
//   fork/create.ts, search/ai.ts: create threads that already hold messages,
//                            so they never precede a first message.
// Routes that touch an existing row without creating one: threads/rename.ts
// (Rename) and messages/list.ts, the reopen read (Reopen).

let harness: FirstSendHarness;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  ids = fixture.ids;
  harness = await createFirstSendHarness({ ids, testDb: fixture.testDb });
});

afterAll(async () => {
  await harness.dispose();
  await releaseRlsFixture();
});

/** What the pre-send writes so far imply about the thread. */
type Model = {
  scope: ChatSendScope;
  threadId: SafeId<"chatThread">;
  rowExists: boolean;
  chatModel: string | null;
  webSearchEnabled: boolean;
};
type Real = { harness: FirstSendHarness };

const storedSettingsMatch = async (model: Model) => {
  const row = await harness.storedThread(model.threadId);
  expect(row === undefined).toBe(!model.rowExists);
  if (row !== undefined) {
    expect(row.chatModel).toBe(model.chatModel);
    expect(row.webSearchEnabled).toBe(model.webSearchEnabled);
  }
};

class PickModel implements fc.AsyncCommand<Model, Real> {
  readonly model: (typeof PICKABLE_CHAT_MODELS)[number];
  constructor(model: (typeof PICKABLE_CHAT_MODELS)[number]) {
    this.model = model;
  }
  check = () => true;
  async run(model: Model, real: Real) {
    expect(
      await real.harness.setModel({
        model: this.model,
        scope: model.scope,
        threadId: model.threadId,
      }),
    ).toMatchObject({ ok: true });
    model.rowExists = true;
    model.chatModel = this.model;
    await storedSettingsMatch(model);
  }
  toString = () => `PickModel(${String(this.model)})`;
}

class ToggleWebSearch implements fc.AsyncCommand<Model, Real> {
  readonly enabled: boolean;
  constructor(enabled: boolean) {
    this.enabled = enabled;
  }
  check = () => true;
  async run(model: Model, real: Real) {
    expect(
      await real.harness.setWebSearch({
        enabled: this.enabled,
        scope: model.scope,
        threadId: model.threadId,
      }),
    ).toMatchObject({ ok: true });
    model.rowExists = true;
    model.webSearchEnabled = this.enabled;
    await storedSettingsMatch(model);
  }
  toString = () => `ToggleWebSearch(${String(this.enabled)})`;
}

class Reopen implements fc.AsyncCommand<Model, Real> {
  check = () => true;
  async run(model: Model, real: Real) {
    const outcome = await real.harness.reopen({
      scope: model.scope,
      threadId: model.threadId,
    });
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        activeSkill: null,
        messages: [],
        model: model.chatModel,
        threadExists: model.rowExists,
        webSearchEnabled: model.webSearchEnabled,
      },
    });
    await storedSettingsMatch(model);
  }
  toString = () => "Reopen";
}

class Rename implements fc.AsyncCommand<Model, Real> {
  check = () => true;
  async run(model: Model, real: Real) {
    const outcome = await real.harness.rename({
      scope: model.scope,
      threadId: model.threadId,
      title: "Renamed before the first message",
    });
    // A rename never creates the thread.
    expect(outcome).toMatchObject(
      model.rowExists ? { ok: true } : { ok: false, status: 404 },
    );
    await storedSettingsMatch(model);
  }
  toString = () => "Rename";
}

/** Opening the matter file's chat while this draft is open adopts its id. */
class AdoptFileChat implements fc.AsyncCommand<Model, Real> {
  check = (model: Readonly<Model>) => model.scope === "workspace";
  async run(model: Model, real: Real) {
    expect(await real.harness.resolveFile(model.threadId)).toBe(model.threadId);
    model.rowExists = true;
    await storedSettingsMatch(model);
  }
  toString = () => "AdoptFileChat";
}

const preSendCommands = fc.commands(
  [
    fc.constantFrom(...PICKABLE_CHAT_MODELS).map((m) => new PickModel(m)),
    fc.boolean().map((enabled) => new ToggleWebSearch(enabled)),
    fc.constant(new Reopen()),
    fc.constant(new Rename()),
    fc.constant(new AdoptFileChat()),
  ],
  { maxCommands: 5 },
);

const THREAD_ORIGINS = [
  "draft-global",
  "draft-workspace",
  "template",
  "file",
] as const;
type ThreadOrigin = (typeof THREAD_ORIGINS)[number];

const openThread = async (origin: ThreadOrigin): Promise<Model> => {
  const blank = { chatModel: null, webSearchEnabled: false };
  switch (origin) {
    case "draft-global":
      return {
        ...blank,
        rowExists: false,
        scope: "global",
        threadId: harness.newDraftThreadId(),
      };
    case "draft-workspace":
      return {
        ...blank,
        rowExists: false,
        scope: "workspace",
        threadId: harness.newDraftThreadId(),
      };
    case "template":
      return {
        ...blank,
        rowExists: true,
        scope: "global",
        threadId: await harness.rotateTemplate(),
      };
    case "file":
      return {
        ...blank,
        rowExists: true,
        scope: "workspace",
        threadId: await harness.resolveFile(),
      };
    default:
      origin satisfies never;
      throw new TypeError("Unhandled thread origin");
  }
};

/** The installed skill, named by id, or any built-in skill, named by name. */
const skillValue = (): fc.Arbitrary<
  NonNullable<ChatSendRequest["activeSkill"]>
> =>
  fc.oneof(
    fc.constant(harness.activeValues.activeSkill),
    fc
      .constantFrom(...listSkillMetadata().map(({ name }) => name))
      .map((skillName) => ({ skillName })),
  );

/** Any mix of what a first send creates its thread with. */
const firstSendArbitrary = (): fc.Arbitrary<CarriedSendContext> =>
  fc.record(
    {
      activeDecision: fc.constant(harness.activeValues.activeDecision),
      activeDraft: fc.constant(harness.activeValues.activeDraft),
      activeSkill: skillValue(),
      contextMatterIds: fc.subarray([ids.wsA1, ids.wsA2]),
    },
    { requiredKeys: ["contextMatterIds"] },
  );

/** Shown on the first send's prompt only when that send carried them. */
const SUBJECT_FIELDS = ["activeDecision", "activeDraft"] as const;

const skillNameLine = (skillName: string) =>
  `Canonical skill name for load-skill/read-skill-resource: ${skillName}`;

const expectSkillSection = (
  systemPrompt: string | undefined,
  skill: ChatSendRequest["activeSkill"] | null,
) => {
  if (skill === undefined || skill === null) {
    expect(systemPrompt).not.toContain(harness.promptMarkers.activeSkill);
    return;
  }
  expect(systemPrompt).toContain(harness.promptMarkers.activeSkill);
  expect(systemPrompt).toContain(skillNameLine(skill.skillName));
};

const sameSet = (values: readonly string[]) => [...new Set(values)].toSorted();

const lifecycleProperty = () =>
  fc.asyncProperty(
    fc.constantFrom(...THREAD_ORIGINS),
    preSendCommands,
    firstSendArbitrary(),
    fc.option(skillValue(), { nil: undefined }),
    async (origin, commands, firstSend, laterSkill) => {
      try {
        const model = await openThread(origin);
        await fc.asyncModelRun(() => ({ model, real: { harness } }), commands);

        // The first send: the thread holds exactly what it carried.
        const first = await harness.send({
          carried: firstSend,
          scope: model.scope,
          threadId: model.threadId,
        });
        expect(first.outcome).toMatchObject({ ok: true });
        const row = await harness.storedThread(model.threadId);
        expect(row).toMatchObject({
          activeSkill: firstSend.activeSkill ?? null,
          chatModel: model.chatModel,
          subjectDecisionId: firstSend.activeDecision?.decisionId ?? null,
          webSearchEnabled: model.webSearchEnabled,
          workspaceId: harness.workspaceIdOf(model.scope),
        });
        expect(sameSet(row?.contextMatterIds ?? [])).toEqual(
          sameSet(firstSend.contextMatterIds ?? []),
        );
        if (firstSend.activeDraft !== undefined) {
          expect(row?.dataWorkspaceIds).toEqual(
            expect.arrayContaining([...harness.draftOriginDataWorkspaceIds]),
          );
        }

        // Its prompt shows a section for each context it carried.
        expectSkillSection(first.systemPrompt, firstSend.activeSkill);
        for (const field of SUBJECT_FIELDS) {
          if (firstSend[field] === undefined) {
            expect(first.systemPrompt).not.toContain(
              harness.promptMarkers[field],
            );
          } else {
            expect(first.systemPrompt).toContain(harness.promptMarkers[field]);
          }
        }
        const pins = firstSend.contextMatterIds ?? [];
        if (pins.length === 0) {
          expect(first.systemPrompt).not.toContain("This chat is pinned to");
        } else {
          const scopeId = harness.workspaceIdOf(model.scope);
          const pinned = new Set([
            ...(scopeId === null ? [] : [scopeId]),
            ...pins,
          ]).size;
          expect(first.systemPrompt).toContain(
            pinned === 1
              ? "MATTER SCOPE: This chat is pinned to one matter."
              : `MATTER SCOPE: This chat is pinned to ${String(pinned)} matters.`,
          );
        }

        // Out of scope for a thread with a subject decision: the reopen and
        // the later send below read that decision through the corpus database
        // itself rather than the send's injected reader, and this test tier
        // has no corpus database. Its stored row and first prompt are checked
        // above like any other thread's; only the steps below are skipped.
        if (firstSend.activeDecision !== undefined) {
          return;
        }

        // A reload reads the same thread back.
        expect(
          await harness.reopen({
            scope: model.scope,
            threadId: model.threadId,
          }),
        ).toMatchObject({
          ok: true,
          value: {
            activeSkill: firstSend.activeSkill ?? null,
            model: model.chatModel,
            threadExists: true,
            webSearchEnabled: model.webSearchEnabled,
          },
        });

        // A later send on the thread, which now holds messages, keeps the
        // skill the thread started with whatever it carries.
        const later = await harness.send({
          carried: {
            ...(laterSkill === undefined ? {} : { activeSkill: laterSkill }),
            contextMatterIds: firstSend.contextMatterIds ?? [],
          },
          scope: model.scope,
          text: "And one more thing.",
          threadId: model.threadId,
        });
        expect(later.outcome).toMatchObject({ ok: true });
        expect(
          (await harness.storedThread(model.threadId))?.activeSkill,
        ).toEqual(firstSend.activeSkill ?? null);
        expectSkillSection(later.systemPrompt, firstSend.activeSkill);
      } finally {
        await harness.resetThreads();
      }
    },
  );

describe("a send carrying context its thread does not run with", () => {
  test("is logged once, by field name only", async () => {
    const warned = spyOn(logger, "warn");
    try {
      const threadId = harness.newDraftThreadId();
      const ignoredWarnings = () =>
        warned.mock.calls.filter(
          ([event]) => event === CHAT_SEND_CONTEXT_IGNORED_EVENT,
        );

      const first = await harness.send({
        carried: { activeSkill: harness.activeValues.activeSkill },
        scope: "global",
        threadId,
      });
      expect(first.outcome).toMatchObject({ ok: true });
      expect(ignoredWarnings()).toEqual([]);

      // The thread now holds a message, so it keeps its own skill.
      const builtIn =
        listSkillMetadata().at(0)?.name ??
        panic("No built-in skill is shipped");
      const later = await harness.send({
        carried: { activeSkill: { skillName: builtIn } },
        scope: "global",
        threadId,
      });
      expect(later.outcome).toMatchObject({ ok: true });
      expect(ignoredWarnings()).toEqual([
        [
          CHAT_SEND_CONTEXT_IGNORED_EVENT,
          { "chat.send.ignored_fields": ["activeSkill"] },
        ],
      ]);
      expect((await harness.storedThread(threadId))?.activeSkill).toEqual(
        harness.activeValues.activeSkill,
      );
    } finally {
      warned.mockRestore();
      await harness.resetThreads();
    }
  });
});

describe("a chat thread before its first message", () => {
  // PR CI runs the seeded budget; the nightly sweep
  // (`PROPERTY_TEST_NUM_RUNS_FACTOR`) runs it ten times over with fresh seeds.
  test(
    "keeps every pre-send setting and exactly the context its first send carried",
    async () => {
      await assertProperty(
        "keeps every pre-send setting and exactly the context its first send carried",
        lifecycleProperty(),
        {
          numRuns: 15,
          // Each run drives the real database, so a failure's shrinking is
          // bounded too: past the limit it reports the smallest
          // counterexample found so far instead of hitting the test timeout.
          interruptAfterTimeLimit: propertyTestTimeout(150_000),
          markInterruptAsFailure: true,
        },
      );
    },
    propertyTestTimeout(240_000),
  );
});
