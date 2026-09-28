import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { decodeMessagePageCursor } from "@/api/handlers/chat/message-page";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createApprovalHarness } from "@/api/tests/helpers/chat-approval-harness";
import type { ChatHarness } from "@/api/tests/helpers/chat-approval-harness";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";
import {
  dumpSavedState,
  findUnlistedChatDataMigrations,
  loadSavedState,
  MIGRATIONS_DIR,
  readSavedStateFixtures,
  rebindSavedState,
  SAVED_STATE_DIR,
  savedStateShape,
  writeSavedStateConversation,
} from "@/api/tests/helpers/chat-saved-state";
import type {
  SavedStateFixture,
  SavedStateRows,
} from "@/api/tests/helpers/chat-saved-state";
import type { WebChatClient } from "@/api/tests/helpers/chat-web-client";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Threads stored by earlier releases, loaded into the current schema and
// driven by the web app's chat runtime against the current send path. Each
// fixture (`__fixtures__/saved-state`) holds the rows one release wrote for
// the same conversation, ending on an approval it still waits on. The page
// must serve everything the release stored, show the waiting card, take the
// user's answer, a follow-up and a retry, and keep every stored message,
// part and turn while it does. Every harness oracle runs after each step.
// The last test fails when the current code stores a shape no fixture has.

const PAST_RELEASE = CHAT_ORACLE.persistedPastReleaseLoads;
const WRITE_ENV = "CHAT_SAVED_STATE_WRITE";

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

const FIXTURES = readSavedStateFixtures();

type RawPart = Record<string, unknown>;
type ServedMessage = { id: string; parts: RawPart[]; role: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A stored message's parts as the release wrote them, read without the
 *  current reader. */
const storedPartsOf = (message: Record<string, unknown>): RawPart[] => {
  const content = message["content"];
  const data = isRecord(content) ? content["data"] : undefined;
  return Array.isArray(data) ? data.filter(isRecord) : [];
};

/** The text a stored or served text part carries, in any envelope. */
const textOf = (part: RawPart): string | null => {
  if (part["type"] !== "text") {
    return null;
  }
  const text = part["content"] ?? part["text"];
  return typeof text === "string" ? text : null;
};

/** Where each tool part names its call. */
const CALL_ID_KEYS = new Map([
  ["tool-call", "id"],
  ["tool-result", "toolCallId"],
]);

/** The id of the tool call a stored or served part belongs to. */
const callIdOf = (part: RawPart): string | null => {
  const key = CALL_ID_KEYS.get(String(part["type"]));
  const id = key === undefined ? undefined : part[key];
  return typeof id === "string" ? id : null;
};

const approvedOf = (part: RawPart): unknown =>
  isRecord(part["approval"]) ? part["approval"]["approved"] : undefined;

/**
 * What `parts` lost of `stored`: a text, a tool call, its approval answer,
 * its output, or a tool result.
 */
const lostParts = (stored: RawPart[], parts: RawPart[]): unknown[] => {
  const lost: unknown[] = [];
  for (const part of stored) {
    const text = textOf(part);
    if (text !== null) {
      if (!parts.some((candidate) => textOf(candidate) === text)) {
        lost.push({ text });
      }
      continue;
    }
    const callId = callIdOf(part);
    if (callId === null) {
      continue;
    }
    const kept = parts.find(
      (candidate) =>
        candidate["type"] === part["type"] && callIdOf(candidate) === callId,
    );
    if (kept === undefined) {
      lost.push({ part: part["type"], toolCallId: callId });
      continue;
    }
    if (part["type"] === "tool-call") {
      if (kept["name"] !== part["name"]) {
        lost.push({
          name: part["name"],
          served: kept["name"],
          toolCallId: callId,
        });
      }
      if (
        approvedOf(part) !== undefined &&
        approvedOf(kept) !== approvedOf(part)
      ) {
        lost.push({ approved: approvedOf(part), toolCallId: callId });
      }
      if (!Bun.deepEquals(inputOf(kept), inputOf(part))) {
        lost.push({ input: inputOf(part), toolCallId: callId });
      }
      const output = outputOf(part);
      if (
        output !== undefined &&
        !resultsOf(parts, callId).some((result) =>
          Bun.deepEquals(result, output),
        )
      ) {
        lost.push({ output, toolCallId: callId });
      }
    }
    if (part["type"] === "tool-result") {
      const content = parsedJson(part["content"]);
      if (
        typeof part["content"] === "string" &&
        !resultsOf(parts, callId).some((result) =>
          Bun.deepEquals(result, content),
        )
      ) {
        lost.push({ result: content, toolCallId: callId });
      }
    }
  }
  return lost;
};

/** `text` parsed as JSON, or `text` itself when it is not JSON. */
const parsedJson = (text: unknown): unknown => {
  if (typeof text !== "string") {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * A tool call's input, in any envelope: v3's `{ status, value }` or
 * `{ status: "raw", rawArguments }`, v2's bare `input`, or the `arguments`
 * text a served call carries.
 */
const inputOf = (part: RawPart): unknown => {
  const input = part["input"];
  if (isRecord(input) && input["status"] === "parsed" && "value" in input) {
    return input["value"];
  }
  if (isRecord(input) && input["status"] === "raw") {
    return parsedJson(input["rawArguments"]);
  }
  return input === undefined ? parsedJson(part["arguments"]) : input;
};

/** A tool call's output: v3 stores it as `{ value }`, v2 and a served call
 *  bare. */
const outputOf = (part: RawPart): unknown => {
  const output = part["output"];
  return isRecord(output) &&
    Object.keys(output).length === 1 &&
    "value" in output
    ? output["value"]
    : output;
};

/** Every result `parts` carry for `callId`: the call's output, and each
 *  tool result's content. */
const resultsOf = (parts: RawPart[], callId: string): unknown[] =>
  parts
    .filter((candidate) => callIdOf(candidate) === callId)
    .map((candidate) =>
      candidate["type"] === "tool-call"
        ? outputOf(candidate)
        : parsedJson(candidate["content"]),
    )
    .filter((result) => result !== undefined);

/** Everything a page serves of `threadId`, every page of it. */
const readServed = async (
  harness: ChatHarness,
  threadId: SafeId<"chatThread">,
): Promise<ServedMessage[]> => {
  const served: unknown[] = [];
  let page = await harness.readPage(threadId);
  served.push(...page.messages);
  while (page.olderCursor !== null) {
    const before = decodeMessagePageCursor(page.olderCursor);
    if (before === null) {
      throw new TypeError("The page served an invalid cursor");
    }
    page = await harness.readPage(threadId, before);
    served.push(...page.messages);
  }
  return asTestRaw<ServedMessage[]>(served);
};

/** What the served thread lost of the stored rows. */
const findServedLosses = (
  stored: SavedStateRows,
  served: ServedMessage[],
): OracleViolation[] =>
  violationsOf(
    PAST_RELEASE,
    (stored.chat_messages ?? []).flatMap((row): unknown[] => {
      const message = served.find(({ id }) => id === row["id"]);
      if (message === undefined) {
        return [{ unservedMessage: row["id"] }];
      }
      const lost = lostParts(storedPartsOf(row), message.parts);
      return lost.length === 0 ? [] : [{ messageId: row["id"], served: lost }];
    }),
  );

/**
 * What continuing the thread lost of the rows it started from: a message,
 * a part of the message it continued, a changed earlier message, or a turn.
 */
const findStoredLosses = ({
  after,
  before,
  continuedMessageId,
}: {
  after: SavedStateRows;
  before: SavedStateRows;
  continuedMessageId: string | null;
}): OracleViolation[] => {
  const findings: unknown[] = [];
  const afterMessages = new Map(
    (after.chat_messages ?? []).map((row) => [row["id"], row]),
  );
  for (const row of before.chat_messages ?? []) {
    const kept = afterMessages.get(row["id"]);
    if (kept === undefined) {
      findings.push({ deletedMessage: row["id"] });
      continue;
    }
    if (row["id"] === continuedMessageId) {
      const lost = lostParts(storedPartsOf(row), storedPartsOf(kept));
      if (lost.length > 0) {
        findings.push({ messageId: row["id"], stored: lost });
      }
      continue;
    }
    if (!Bun.deepEquals(kept["content"], row["content"])) {
      findings.push({ rewrittenMessage: row["id"] });
    }
  }
  const afterTurns = new Map(
    (after.chat_turns ?? []).map((row) => [row["id"], row]),
  );
  for (const turn of before.chat_turns ?? []) {
    const kept = afterTurns.get(turn["id"]);
    if (kept === undefined) {
      findings.push({ deletedTurn: turn["id"] });
    } else if (
      turn["status"] !== "awaiting-user" &&
      kept["status"] !== turn["status"]
    ) {
      findings.push({
        from: turn["status"],
        to: kept["status"],
        turn: turn["id"],
      });
    }
  }
  return violationsOf(PAST_RELEASE, findings);
};

/** Per oracle that can report a defect a release stored: the finding's
 *  field naming the tool call. */
const DEFECT_NAME_FIELDS: ReadonlyMap<string, string> = new Map([
  [CHAT_ORACLE.persistedCallsSettled, "toolCallId"],
  [CHAT_ORACLE.liveToolPartsOnce, "key"],
]);

/** The stored defect a harness finding names, as a fixture declares it:
 *  `<oracle> <tool call>`. */
const storedDefectOf = ({ detail, oracle }: OracleViolation): string | null => {
  if (!isRecord(detail)) {
    return null;
  }
  // Only these two oracles report a defect a release stored; any other
  // finding is never inherited.
  const name = DEFECT_NAME_FIELDS.get(oracle);
  return name === undefined ? null : `${oracle} ${String(detail[name])}`;
};

/** Runs `step`; a throw is a finding of the past-release oracle. */
const attempt = async (
  label: string,
  step: () => Promise<OracleViolation[]>,
): Promise<OracleViolation[]> => {
  try {
    return await step();
  } catch (error) {
    return violationsOf(PAST_RELEASE, [
      { failed: label, error: error instanceof Error ? error.message : error },
    ]);
  }
};

type Decision = "approve" | "deny";

/**
 * Loads `raw`, opens the page on it, answers its waiting approval with
 * `decision`, then sends a follow-up (and, after an approval, retries the
 * answer). Returns every finding.
 */
const continueSavedThread = async (
  raw: SavedStateFixture,
  decision: Decision,
): Promise<{ executions: string[]; violations: OracleViolation[] }> => {
  const fixture = rebindSavedState(raw, {
    organizationId: ids.orgA,
    userId: ids.userA1,
  });
  const threadId = toSafeId<"chatThread">(fixture.threadId);
  seededThreadIds.push(threadId);
  const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
  const violations: OracleViolation[] = [];
  let client: WebChatClient | undefined;
  try {
    const loaded = await attempt("load", async () => {
      await loadSavedState(testDb, fixture);
      return [];
    });
    violations.push(...loaded);
    if (loaded.length > 0) {
      return { executions: harness.executions, violations };
    }
    const before = await dumpSavedState(testDb, threadId);
    const owner = (before.chat_turns ?? []).find(
      (turn) => turn["status"] === "awaiting-user",
    )?.["assistant_message_id"];
    const continued = typeof owner === "string" ? owner : null;

    violations.push(
      ...(await attempt("reload", async () =>
        findServedLosses(before, await readServed(harness, threadId)),
      )),
    );
    const opened = await attempt("open", async () => {
      client = await harness.openWebClient(threadId);
      return [];
    });
    violations.push(...opened);
    const page = client;
    if (page === undefined) {
      return { executions: harness.executions, violations };
    }
    // Defects the release itself stored (an approved call it never closed, a
    // call it copied into later messages) stay in the thread: the fixture
    // declares them, and only a finding beyond them counts.
    const atLoad = await harness.checkWebClient({ client: page, threadId });
    const declared = new Set(fixture.storedDefects);
    const inherited = atLoad.filter((finding) =>
      declared.has(storedDefectOf(finding) ?? ""),
    );
    const found = new Set(inherited.map((finding) => storedDefectOf(finding)));
    violations.push(
      ...atLoad.filter((finding) => !inherited.includes(finding)),
      ...violationsOf(
        PAST_RELEASE,
        [...declared]
          .filter((defect) => !found.has(defect))
          .map((defect) => ({ declaredDefectNotFound: defect })),
      ),
    );
    const inheritedKeys = new Set(
      inherited.map((finding) => JSON.stringify(finding)),
    );
    const beyondInherited = (findings: OracleViolation[]) =>
      findings.filter((finding) => !inheritedKeys.has(JSON.stringify(finding)));

    type Step = readonly [string, () => Promise<void>];
    const steps: Step[] = [
      [
        decision,
        async () => {
          harness.script(threadId, [
            {
              finishReason: "stop",
              text: decision === "approve" ? "Deleted." : "Kept.",
              type: "text",
            },
          ]);
          await page.approve(fixture.pendingToolCallId, decision === "approve");
        },
      ],
      [
        "follow-up",
        async () => {
          harness.script(threadId, [
            {
              finishReason: "stop",
              text: "Nothing else is open.",
              type: "text",
            },
          ]);
          await page.sendUserMessage(Bun.randomUUIDv7(), "Anything else?");
        },
      ],
      ...(decision === "approve"
        ? ([
            [
              "retry",
              async () => {
                harness.script(threadId, [
                  {
                    finishReason: "stop",
                    text: "Still nothing.",
                    type: "text",
                  },
                ]);
                await page.resend();
              },
            ],
          ] satisfies Step[])
        : []),
    ];
    for (const [label, step] of steps) {
      violations.push(
        ...(await attempt(label, async () => {
          await step();
          return beyondInherited(
            await harness.checkWebClient({ client: page, threadId }),
          );
        })),
      );
    }

    const after = await dumpSavedState(testDb, threadId);
    violations.push(
      ...findStoredLosses({
        after,
        before,
        continuedMessageId: continued,
      }),
      ...(await attempt("reload after", async () =>
        findServedLosses(
          {
            chat_messages: (before.chat_messages ?? []).filter(
              ({ id }) => id !== continued,
            ),
          },
          await readServed(harness, threadId),
        ),
      )),
    );
    return { executions: [...harness.executions], violations };
  } finally {
    client?.dispose();
    harness.close();
  }
};

describe("a thread an earlier release stored", () => {
  test("has fixtures to load", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  for (const fixture of FIXTURES) {
    const label = `${fixture.release ?? "main"} (${fixture.sourceCommit.slice(0, 10)})`;

    test(`${label} reloads, takes its approval, a follow-up and a retry`, async () => {
      const { executions, violations } = await continueSavedThread(
        fixture,
        "approve",
      );
      expect(violations).toEqual([]);
      expect(executions).toEqual(["lease"]);
    });

    test(`${label} reloads, takes a denial and a follow-up`, async () => {
      const { executions, violations } = await continueSavedThread(
        fixture,
        "deny",
      );
      expect(violations).toEqual([]);
      expect(executions).toEqual([]);
    });
  }
});

describe("the saved-state fixtures", () => {
  test("run every migration that rewrites stored chat rows", () => {
    const oldest = FIXTURES.map(({ newestMigration }) => newestMigration)
      .toSorted()
      .at(0);
    expect(findUnlistedChatDataMigrations(oldest ?? "")).toEqual([]);
  });

  test("cover the shape the current code stores", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    let pendingToolCallId: string;
    try {
      pendingToolCallId = await writeSavedStateConversation(harness, threadId);
    } finally {
      harness.close();
    }
    const rows = await dumpSavedState(testDb, threadId);
    const shape = savedStateShape(rows);

    const target = process.env[WRITE_ENV];
    if (target !== undefined && target !== "") {
      writeFixture({ pendingToolCallId, rows, target, threadId });
    }

    const nearest = FIXTURES.map((fixture) => {
      const known = new Set(savedStateShape(fixture.rows));
      return {
        missing: shape.filter((entry) => !known.has(entry)),
        release: fixture.release ?? fixture.sourceCommit,
        unwritten: [...known].filter((entry) => !shape.includes(entry)),
      };
    }).toSorted(
      (left, right) =>
        left.missing.length +
        left.unwritten.length -
        (right.missing.length + right.unwritten.length),
    )[0];
    // A new stored shape needs a fixture: `bun run gen:chat-saved-state`.
    expect(
      nearest === undefined ||
        nearest.missing.length + nearest.unwritten.length > 0
        ? violationsOf(PAST_RELEASE, [
            {
              unfixturedShape: nearest ?? shape,
              fix: "bun run gen:chat-saved-state",
            },
          ])
        : [],
    ).toEqual([]);
  });
});

/** Writes the current code's rows as a fixture named `target`. */
const writeFixture = ({
  pendingToolCallId,
  rows,
  target,
  threadId,
}: {
  pendingToolCallId: string;
  rows: SavedStateRows;
  target: string;
  threadId: string;
}) => {
  const git = (...args: string[]) =>
    new TextDecoder()
      .decode(Bun.spawnSync(["git", ...args], { cwd: SAVED_STATE_DIR }).stdout)
      .trim();
  const migrations = readdirSync(MIGRATIONS_DIR).filter((name) =>
    /^\d{14}_/u.test(name),
  );
  const fixture: SavedStateFixture = {
    release: null,
    sourceCommit: git("rev-parse", "HEAD"),
    newestMigration: migrations.toSorted().at(-1) ?? "",
    shape: "TODO: what this stored shape adds or drops",
    actors: { organizationId: ids.orgA, userId: ids.userA1 },
    threadId,
    pendingToolCallId,
    rows,
  };
  writeFileSync(
    path.join(SAVED_STATE_DIR, `${target}.json`),
    `${JSON.stringify(fixture, null, 2)}\n`,
  );
};
