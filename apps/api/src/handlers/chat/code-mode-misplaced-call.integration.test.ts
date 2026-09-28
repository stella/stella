import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { CODE_MODE_EXECUTE_TOOL_NAME } from "@/api/handlers/chat/tools/execute/chat-code-mode";
import type { ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createApprovalHarness } from "@/api/tests/helpers/chat-approval-harness";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A model that calls a direct tool inside a code-mode script is told, in the
// script's result, which tool it meant and how to call it; it then makes the
// direct call and the turn completes through the tool's approval.

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const DIRECT_TOOL = "save_playbook";
const PLAYBOOK_INPUT = { name: "NDA review" };
/** Reads in the script, then calls the write as if it were a function. */
const MISPLACED_CALL_SCRIPT = `const { matters } = await external_list_matters({});
await save_playbook(${JSON.stringify(PLAYBOOK_INPUT)});
return matters.length;`;

const asks = (
  calls: Extract<ScriptedTurn, { type: "step" }>["toolCalls"],
): ScriptedTurn => ({ type: "step", toolCalls: calls });

const storedCall = async (
  harness: ReturnType<typeof createApprovalHarness>,
  threadId: SafeId<"chatThread">,
  callId: string,
) => {
  const call = (await harness.readThreadMessages(threadId))
    .flatMap(({ parts }) => parts)
    .find(
      (part): part is Extract<ChatPart, { type: "tool-call" }> =>
        part.type === "tool-call" && part.id === callId,
    );
  return call ?? expect.unreachable(`No stored call ${callId}`);
};

/** The script's result names the direct tool and where to call it. */
const explainsMisplacedCall = (output: unknown): boolean => {
  const serialized = JSON.stringify(output ?? null);
  return (
    serialized.includes('"name":"not-a-script-function"') &&
    serialized.includes(
      `\`${DIRECT_TOOL}\` is a direct tool, not a script function. Call it as its own tool call outside execute_typescript.`,
    )
  );
};

describe("a script that calls a direct tool", () => {
  test("is told to call it directly, and the turn completes with the direct call", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    const client = await harness.openWebClient(threadId);
    try {
      harness.script(threadId, [
        asks([
          {
            arguments: JSON.stringify({
              typescriptCode: MISPLACED_CALL_SCRIPT,
            }),
            toolCallId: "call-script",
            toolName: CODE_MODE_EXECUTE_TOOL_NAME,
          },
        ]),
        asks([
          {
            arguments: JSON.stringify(PLAYBOOK_INPUT),
            toolCallId: "call-save",
            toolName: DIRECT_TOOL,
          },
        ]),
      ]);
      await client.sendUserMessage(Bun.randomUUIDv7(), "Save an NDA playbook");
      await client.settle();
      await harness.expectSoundWebClient({ client, harness, threadId });

      const script = await storedCall(harness, threadId, "call-script");
      expect(
        violationsOf(
          CHAT_ORACLE.codeModeMisplacedCallExplained,
          explainsMisplacedCall(script.output)
            ? []
            : [{ callId: "call-script", output: script.output }],
        ),
      ).toEqual([]);

      // The model's direct call waits on its approval like any write.
      harness.script(threadId, [
        { type: "step", text: "Saved the playbook.", toolCalls: [] },
      ]);
      await client.approve("call-save", true);
      await client.settle();
      await harness.expectSoundWebClient({ client, harness, threadId });

      const save = await storedCall(harness, threadId, "call-save");
      expect(save.output).toBeDefined();
      const messages = await harness.readThreadMessages(threadId);
      expect(
        messages
          .flatMap(({ parts }) => parts)
          .some(
            (part) =>
              part.type === "text" && part.content === "Saved the playbook.",
          ),
      ).toBe(true);
    } finally {
      client.dispose();
      harness.close();
    }
  });
});
