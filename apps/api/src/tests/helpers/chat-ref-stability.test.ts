import { describe, expect, test } from "bun:test";

import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";
import { createRefStabilityLedger } from "@/api/tests/helpers/chat-ref-stability";

const THREAD_ID = "thread-1";
/** The thread state of a thread that stored `ent_1`. */
const SHOWN: ReadonlySet<string> = new Set(["ent_1"]);
const WORKSPACE_ID = brandPersistedWorkspaceId(
  "01a0df7d-c93a-7105-99f9-c66cf1b14d01",
);
const DOCUMENT_A = {
  entityId: brandPersistedEntityId("01a0df7d-c93a-7105-99f9-c66cf1b14d0a"),
  workspaceId: WORKSPACE_ID,
};
const DOCUMENT_B = {
  entityId: brandPersistedEntityId("01a0df7d-c93a-7105-99f9-c66cf1b14d0b"),
  workspaceId: WORKSPACE_ID,
};

/** A stored thread whose code-mode result shows `text` verbatim. */
const storedResult = (text: string) => [
  { parts: [{ output: { result: text }, type: "tool-call" }] },
];

/** A first request that stored `ent_1` for document A. */
const firstRequest = () => {
  const ledger = createRefStabilityLedger();
  const registry = ledger.track(THREAD_ID, createChatRefRegistry());
  const ref = registry.toEntityRef(DOCUMENT_A);
  const stored = storedResult(`Listed ${ref}`);
  expect(
    ledger.check({ stored, threadId: THREAD_ID, threadRefs: SHOWN }),
  ).toEqual([]);
  return { ledger, ref, registry, stored };
};

describe("chat.persisted.refs-stable", () => {
  test("a later request that cannot resolve a stored ref breaks it", () => {
    const { ledger, ref, stored } = firstRequest();
    ledger.track(THREAD_ID, createChatRefRegistry());

    expect(
      ledger.check({ stored, threadId: THREAD_ID, threadRefs: SHOWN }),
    ).toMatchObject([
      { detail: { later: null, ref }, oracle: CHAT_ORACLE.persistedRefsStable },
    ]);
  });

  test("a later request that gives the spelling to another target breaks it", () => {
    const { ledger, ref, stored } = firstRequest();
    const next = ledger.track(THREAD_ID, createChatRefRegistry());
    expect(next.toEntityRef(DOCUMENT_B)).toBe(ref);

    expect(
      ledger.check({ stored, threadId: THREAD_ID, threadRefs: SHOWN }),
    ).toMatchObject([
      {
        detail: {
          later: `entity ${WORKSPACE_ID}/${DOCUMENT_B.entityId}`,
          ref,
          shown: `entity ${WORKSPACE_ID}/${DOCUMENT_A.entityId}`,
        },
      },
    ]);
    expect(ledger.findingsOf(THREAD_ID)).toHaveLength(1);
  });

  test("a later request that restores the stored refs keeps them", () => {
    const { ledger, registry, stored } = firstRequest();
    const next = ledger.track(
      THREAD_ID,
      createChatRefRegistry(
        registry.collectRefBindings({ outputs: stored, texts: [] }),
      ),
    );
    next.toEntityRef(DOCUMENT_B);

    expect(
      ledger.check({ stored, threadId: THREAD_ID, threadRefs: SHOWN }),
    ).toEqual([]);
  });

  test("a ref-shaped token no request minted is not tracked", () => {
    const ledger = createRefStabilityLedger();
    ledger.track(THREAD_ID, createChatRefRegistry());
    const typed = storedResult("the user typed ent_7");
    expect(
      ledger.check({ stored: typed, threadId: THREAD_ID, threadRefs: SHOWN }),
    ).toEqual([]);
    ledger.track(THREAD_ID, createChatRefRegistry());

    expect(
      ledger.check({ stored: typed, threadId: THREAD_ID, threadRefs: SHOWN }),
    ).toEqual([]);
  });

  test("a stored ref the thread's ref state lacks breaks it", () => {
    const ledger = createRefStabilityLedger();
    const registry = ledger.track(THREAD_ID, createChatRefRegistry());
    const stored = storedResult(`Listed ${registry.toEntityRef(DOCUMENT_A)}`);

    expect(
      ledger.check({ stored, threadId: THREAD_ID, threadRefs: new Set() }),
    ).toMatchObject([{ detail: { missingFromThreadState: "ent_1" } }]);
  });
});
