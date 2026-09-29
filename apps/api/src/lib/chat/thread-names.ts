import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { chatMessages, chatThreadNames } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { findChatRefTokens } from "@/api/lib/chat/ref-registry";
import {
  type ChatRefBinding,
  getChatRefBindings,
  isChatRefBinding,
  isChatRefContext,
} from "@/api/lib/chat/ref-token";
import {
  CHAT_THREAD_NAME_KIND,
  type ChatThreadNameKind,
} from "@/api/lib/chat/thread-name-kinds";
import { TelemetryError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

// A chat thread's name ledger: the names one request minted that every later
// request of the thread must read the same way. A request reads them once
// (`readChatThreadNames`) and the transaction that stores its assistant
// message appends the new ones (`recordChatThreadNamesOnTx`).

/** Every name a thread's history holds. */
type ChatThreadNames = {
  /** Chat refs shown to the model, with their targets. */
  refBindings: ChatRefBinding[];
  /** Ref spellings shown without a known target; they resolve to nothing. */
  retiredRefs: string[];
  /** Tool-call ids the thread's stored messages hold. */
  toolCallIds: string[];
};

/**
 * Where a thread's names were read from: its ledger, or, for a thread whose
 * ledger has not started yet, its stored messages (once; the next write
 * starts the ledger with them).
 */
export type ChatThreadNamesRead = ChatThreadNames & {
  source: "ledger" | "messages";
};

/** The names a request adds to the thread. */
export type ChatThreadNamesAdded = Pick<
  ChatThreadNames,
  "refBindings" | "toolCallIds"
>;

export const EMPTY_CHAT_THREAD_NAMES_READ: ChatThreadNamesRead = {
  refBindings: [],
  retiredRefs: [],
  source: "messages",
  toolCallIds: [],
};

const LEDGER_DEFECT_SINK = failureSink({
  event: "chat.thread_names.ledger_defect",
  expected: [],
});

const reportLedgerDefect = (message: string): void => {
  observeFailure(new TelemetryError({ message }), {
    sink: LEDGER_DEFECT_SINK,
  });
};

/**
 * The names the stored messages of a thread without a ledger hold. A ref
 * bound to two targets, or shown by a message stored before bindings
 * existed, is retired: it resolves to nothing instead of to a guess.
 */
const deriveChatThreadNames = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  /** Any connection that may read the thread's messages. */
  tx: Pick<Transaction, "select">;
}): Promise<ChatThreadNames> => {
  const refContextPath = sql`${chatMessages.content}->'metadata'->'refContext'`;
  const rows = await tx
    .select({
      refContext: sql<unknown>`${refContextPath}`,
      // A message stored before bindings existed is read whole, once, for
      // the spellings it showed; any other message only for its bindings.
      legacyContent: sql<string | null>`CASE
        WHEN ${refContextPath}->>'version' = '2' THEN NULL
        ELSE ${chatMessages.content}::text
      END`,
      // A call part keeps its id in `id`; legacy `tool-<name>` and
      // `dynamic-tool` parts may keep it in either `toolCallId` or `id`.
      toolCallIds: sql<unknown>`jsonb_path_query_array(
        ${chatMessages.content},
        '$.data[*] ? (@.type == "tool-call").id'
      ) || jsonb_path_query_array(
        ${chatMessages.content},
        '$.data[*] ? (@.type == "dynamic-tool" || (@.type starts with "tool-" && @.type != "tool-call" && @.type != "tool-result")).toolCallId'
      ) || jsonb_path_query_array(
        ${chatMessages.content},
        '$.data[*] ? (@.type == "dynamic-tool" || (@.type starts with "tool-" && @.type != "tool-call" && @.type != "tool-result")).id'
      )`,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        eq(chatMessages.role, "assistant"),
      ),
    );

  const targetsByRef = new Map<string, Map<string, ChatRefBinding>>();
  for (const { refContext } of rows) {
    const bindings = isChatRefContext(refContext)
      ? getChatRefBindings(refContext)
      : [];
    for (const binding of bindings) {
      const targets =
        targetsByRef.get(binding.ref) ?? new Map<string, ChatRefBinding>();
      targets.set(JSON.stringify({ ...binding, ref: undefined }), binding);
      targetsByRef.set(binding.ref, targets);
    }
  }
  // A spelling a message stored before bindings existed showed the model
  // named something history cannot prove, even when a later message bound
  // the same spelling: the model may still read it the earlier way.
  const legacyRefs = new Set(
    rows.flatMap(({ legacyContent }) =>
      legacyContent === null ? [] : findChatRefTokens(legacyContent),
    ),
  );
  const refBindings: ChatRefBinding[] = [];
  const conflicted: string[] = [];
  for (const [ref, targets] of targetsByRef) {
    const only = targets.size === 1 ? [...targets.values()].at(0) : undefined;
    if (only === undefined || legacyRefs.has(ref)) {
      conflicted.push(ref);
    } else {
      refBindings.push(only);
    }
  }
  const retiredRefs = [...new Set([...conflicted, ...legacyRefs])];
  if (retiredRefs.length > 0) {
    reportLedgerDefect("A chat thread retired refs its history cannot bind");
  }
  const toolCallIds = [
    ...new Set(
      rows.flatMap(({ toolCallIds: ids }) =>
        Array.isArray(ids)
          ? ids.filter((id): id is string => typeof id === "string")
          : [],
      ),
    ),
  ];
  return { refBindings, retiredRefs, toolCallIds };
};

/**
 * Every name the thread's history holds: one indexed read of its ledger, or,
 * before the ledger starts, a one-off derivation from its stored messages.
 * Run in a transaction that has read the thread under its owner's scope.
 */
export const readChatThreadNames = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Pick<Transaction, "select">;
}): Promise<ChatThreadNamesRead> => {
  const rows = await tx
    .select({
      kind: chatThreadNames.kind,
      name: chatThreadNames.name,
      target: chatThreadNames.target,
    })
    .from(chatThreadNames)
    .where(eq(chatThreadNames.threadId, threadId));
  if (!rows.some(({ kind }) => kind === CHAT_THREAD_NAME_KIND.ledgerStart)) {
    return {
      ...(await deriveChatThreadNames({ threadId, tx })),
      source: "messages",
    };
  }
  const read: ChatThreadNamesRead = {
    refBindings: [],
    retiredRefs: [],
    source: "ledger",
    toolCallIds: [],
  };
  for (const { kind, name, target } of rows) {
    switch (kind) {
      case CHAT_THREAD_NAME_KIND.refBinding:
        if (isChatRefBinding(target) && target.ref === name) {
          read.refBindings.push(target);
        } else {
          // A binding that no longer parses names nothing it can prove.
          reportLedgerDefect("A stored chat ref binding is invalid");
          read.retiredRefs.push(name);
        }
        break;
      case CHAT_THREAD_NAME_KIND.retiredRef:
        read.retiredRefs.push(name);
        break;
      case CHAT_THREAD_NAME_KIND.toolCallId:
        read.toolCallIds.push(name);
        break;
      case CHAT_THREAD_NAME_KIND.ledgerStart:
        break;
      default:
        kind satisfies never;
        return panic(`Unhandled chat thread name kind: ${String(kind)}`);
    }
  }
  // A retired spelling names nothing, whatever a binding row says.
  const retired = new Set(read.retiredRefs);
  read.refBindings = read.refBindings.filter(({ ref }) => !retired.has(ref));
  return read;
};

/** What a binding names, independent of its spelling and key order. */
const refTargetKey = (binding: ChatRefBinding): string => {
  switch (binding.kind) {
    case "contact":
      return JSON.stringify([binding.kind, binding.contact.id]);
    case "entity":
      return JSON.stringify([
        binding.kind,
        binding.workspace.id,
        binding.entity.id,
      ]);
    case "matter":
      return JSON.stringify([binding.kind, binding.workspace.id]);
    case "property":
      return JSON.stringify([binding.kind, binding.property.id]);
    case "source":
      return JSON.stringify([binding.kind, binding.href]);
    default:
      binding satisfies never;
      return panic("Unhandled chat ref binding");
  }
};

/**
 * Spellings among `bindings` the ledger already holds for another target,
 * or as retired. A request only mints past every held spelling, so any
 * such spelling is a defect in how the request read the ledger.
 */
const findConflictingRefBindings = async ({
  bindings,
  threadId,
  tx,
}: {
  bindings: readonly ChatRefBinding[];
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<string[]> => {
  if (bindings.length === 0) {
    return [];
  }
  const held = await tx
    .select({
      kind: chatThreadNames.kind,
      name: chatThreadNames.name,
      target: chatThreadNames.target,
    })
    .from(chatThreadNames)
    .where(
      and(
        eq(chatThreadNames.threadId, threadId),
        inArray(chatThreadNames.kind, [
          CHAT_THREAD_NAME_KIND.refBinding,
          CHAT_THREAD_NAME_KIND.retiredRef,
        ]),
        inArray(
          chatThreadNames.name,
          bindings.map(({ ref }) => ref),
        ),
      ),
    );
  const targetByRef = new Map(
    bindings.map((binding) => [binding.ref, refTargetKey(binding)]),
  );
  return held.flatMap(({ kind, name, target }) =>
    kind === CHAT_THREAD_NAME_KIND.refBinding &&
    isChatRefBinding(target) &&
    refTargetKey(target) === targetByRef.get(name)
      ? []
      : [name],
  );
};

type ChatThreadNameRow = {
  kind: ChatThreadNameKind;
  name: string;
  target: ChatRefBinding | null;
  threadId: SafeId<"chatThread">;
};

/**
 * Appends what a request adds to the thread's ledger, in the transaction
 * that stores the messages showing it. A thread whose names were derived
 * from its messages starts its ledger here with all of them. A name already
 * held keeps its first row: the registry never mints a held spelling again.
 */
export const recordChatThreadNamesOnTx = async ({
  added,
  read,
  threadId,
  tx,
}: {
  added: ChatThreadNamesAdded;
  read: ChatThreadNamesRead;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<void> => {
  const carried: ChatThreadNames =
    read.source === "messages"
      ? read
      : { refBindings: [], retiredRefs: [], toolCallIds: [] };
  const rows: ChatThreadNameRow[] = [
    ...[...carried.refBindings, ...added.refBindings].map((binding) => ({
      kind: CHAT_THREAD_NAME_KIND.refBinding,
      name: binding.ref,
      target: binding,
      threadId,
    })),
    ...carried.retiredRefs.map((name) => ({
      kind: CHAT_THREAD_NAME_KIND.retiredRef,
      name,
      target: null,
      threadId,
    })),
    ...[...carried.toolCallIds, ...added.toolCallIds].map((name) => ({
      kind: CHAT_THREAD_NAME_KIND.toolCallId,
      name,
      target: null,
      threadId,
    })),
    ...(read.source === "messages"
      ? [
          {
            kind: CHAT_THREAD_NAME_KIND.ledgerStart,
            name: "",
            target: null,
            threadId,
          },
        ]
      : []),
  ];
  if (rows.length === 0) {
    return;
  }
  const conflicting = await findConflictingRefBindings({
    bindings: added.refBindings,
    threadId,
    tx,
  });
  if (conflicting.length > 0) {
    // Storing the message would show the model a spelling that already
    // names something else in this thread; fail the write instead.
    reportLedgerDefect("A chat ref spelling was bound to a second target");
    return panic("A chat ref spelling was bound to a second target");
  }
  // The ledger records names shown by messages whose write is audited in the
  // same transaction.
  await tx.insert(chatThreadNames).values(rows).onConflictDoNothing();
};
